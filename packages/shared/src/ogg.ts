/**
 * Ogg Opus mux/demux for our own per-chunk files.
 *
 * Parses only streams produced by `muxOggOpus` (no continued packets, mapping
 * family 0, OpusHead then OpusTags then audio). Remux is mux ∘ parse.
 * Anything outside that profile throws rather than producing garbage.
 */

const OGG_CAPTURE = 'OggS';
const OPUS_HEAD = 'OpusHead';
const OPUS_TAGS = 'OpusTags';
const VENDOR = 'scribetab';
const DEFAULT_PRE_SKIP = 312;
const TARGET_PAYLOAD = 4096;
const MAX_SEGMENTS = 255;
const HEADER_BYTES = 27;
const MAX_PACKET_SAMPLES_48K = 5760;

const SILK_SAMPLES = [480, 960, 1920, 2880] as const;
const HYBRID_SAMPLES = [480, 960] as const;
const CELT_SAMPLES = [120, 240, 480, 960] as const;

const CRC_TABLE = /*#__PURE__*/ makeCrcTable();

export interface OpusPacket {
  data: Uint8Array;
  /** Granule increment for this packet, always in 48 kHz units. */
  frameSamples48k: number;
}

export interface MuxOggOpusOptions {
  inputSampleRate: number;
  /** Bitstream serial number; required so per-chunk files can differ. */
  serial: number;
  preSkip?: number;
  channels?: number;
}

export interface ParsedOggOpus {
  packets: OpusPacket[];
  preSkip: number;
  inputSampleRate: number;
  channels: number;
  serial: number;
}

/**
 * Duration of an Opus packet in 48 kHz samples, from the TOC byte
 * (RFC 6716 §3.1, §3.2, §3.4).
 */
export function opusPacketSamples48k(data: Uint8Array): number {
  if (data.length === 0) throw new Error('Empty Opus packet');
  const toc = data[0] ?? 0;
  const config = toc >>> 3;
  const code = toc & 3;
  const perFrame =
    config < 12 ? SILK_SAMPLES[config & 3]! :
    config < 16 ? HYBRID_SAMPLES[config & 1]! :
    CELT_SAMPLES[config & 3]!;

  let frames: number;
  if (code === 0) {
    frames = 1;
  } else if (code === 1 || code === 2) {
    frames = 2;
  } else {
    if (data.length < 2) throw new Error('Truncated Opus packet');
    frames = (data[1] ?? 0) & 0x3f;
    if (frames < 1) throw new Error('Invalid Opus frame count');
  }

  const total = frames * perFrame;
  if (total > MAX_PACKET_SAMPLES_48K) {
    throw new Error('Opus packet exceeds 120 ms');
  }
  return total;
}

/**
 * Mux Opus packets into a standalone Ogg Opus bitstream.
 *
 * Audio-page granulepos is preSkip + cumulative 48 kHz samples (RFC 7845 §7);
 * players trim preSkip. Zero-length packets are rejected: WebCodecs DTX
 * surfaces as missing chunks, not empty EncodedAudioChunks.
 */
export function muxOggOpus(packets: OpusPacket[], opts: MuxOggOpusOptions): ArrayBuffer {
  const serial = opts.serial;
  const preSkip = opts.preSkip ?? DEFAULT_PRE_SKIP;
  const channels = opts.channels ?? 1;
  if (channels !== 1 && channels !== 2) {
    throw new Error('channels must be 1 or 2');
  }
  if (!Number.isInteger(preSkip) || preSkip < 0 || preSkip > 65535) {
    throw new Error('preSkip out of range');
  }
  const pages: Uint8Array[] = [];

  const hasAudio = packets.length > 0;
  pages.push(buildPage([opusHead(channels, preSkip, opts.inputSampleRate)], 0x02, 0, serial, 0));
  pages.push(buildPage([opusTags()], hasAudio ? 0 : 0x04, 0, serial, 1));

  if (!hasAudio) return concatPages(pages);

  let seq = 2;
  let granule = preSkip;
  let pagePackets: Uint8Array[] = [];
  let pageSegments = 0;
  let pagePayload = 0;
  let pageGranule = granule;

  const flush = (eos: boolean) => {
    if (pagePackets.length === 0) return;
    pages.push(buildPage(pagePackets, eos ? 0x04 : 0, pageGranule, serial, seq));
    seq += 1;
    pagePackets = [];
    pageSegments = 0;
    pagePayload = 0;
  };

  for (const pkt of packets) {
    const data = pkt.data;
    if (data.length === 0) throw new Error('Zero-length Opus packet');
    const segs = segmentCount(data.length);
    if (segs > MAX_SEGMENTS) {
      throw new Error('Opus packet too large to fit in a single Ogg page');
    }
    const wouldExceedSegs = pageSegments + segs > MAX_SEGMENTS;
    const wouldExceedSize = pagePayload > 0 && pagePayload + data.length > TARGET_PAYLOAD;
    if (wouldExceedSegs || wouldExceedSize) flush(false);
    pagePackets.push(data);
    pageSegments += segs;
    pagePayload += data.length;
    granule += pkt.frameSamples48k;
    pageGranule = granule;
  }
  flush(true);
  return concatPages(pages);
}

/**
 * Parse a bitstream produced by `muxOggOpus`. Per-packet `frameSamples48k` is
 * recovered from the Opus TOC. Audio-page granulepos is preSkip + cumulative
 * samples; preSkip is subtracted before the page-delta cross-check.
 */
export function parseOggOpus(buf: ArrayBuffer): ParsedOggOpus {
  const pages = readPages(buf);
  if (pages.length === 0) throw new Error('Empty Ogg bitstream');

  let preSkip = DEFAULT_PRE_SKIP;
  let inputSampleRate = 0;
  let channels = 1;
  let serial = 0;
  let seenHead = false;
  let seenTags = false;
  let seenEos = false;
  let prevAudioGranule = 0;
  const packets: OpusPacket[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (i === 0) {
      if ((page.headerType & 0x02) === 0) {
        throw new Error('First Ogg page must have BOS');
      }
      serial = page.serial;
    } else {
      if ((page.headerType & 0x02) !== 0) {
        throw new Error('Unexpected BOS flag');
      }
      if (page.serial !== serial) {
        throw new Error('Serial number changed');
      }
    }
    if (seenEos) throw new Error('Page after EOS');
    if (page.sequence !== i) throw new Error('Ogg page sequence gap');
    if ((page.headerType & 0x04) !== 0) seenEos = true;

    const audioOnPage: Uint8Array[] = [];
    for (const pkt of page.packets) {
      if (!seenHead) {
        const head = parseOpusHead(pkt);
        channels = head.channels;
        preSkip = head.preSkip;
        inputSampleRate = head.inputSampleRate;
        seenHead = true;
        prevAudioGranule = preSkip;
        continue;
      }
      if (!seenTags) {
        if (pkt.length < 8 || readAscii(pkt, 0, 8) !== OPUS_TAGS) {
          throw new Error('Missing OpusTags');
        }
        seenTags = true;
        continue;
      }
      if (pkt.length >= 8) {
        const mag = readAscii(pkt, 0, 8);
        if (mag === OPUS_HEAD) throw new Error('Unexpected OpusHead in audio region');
        if (mag === OPUS_TAGS) throw new Error('Unexpected OpusTags in audio region');
      }
      if (pkt.length === 0) throw new Error('Zero-length Opus packet');
      audioOnPage.push(pkt);
    }
    if (i === 0 && !seenHead) throw new Error('Missing OpusHead');

    if (audioOnPage.length === 0) continue;
    if (page.granulePos < prevAudioGranule) {
      throw new Error('Decreasing granule position');
    }
    const delta = page.granulePos - prevAudioGranule;
    prevAudioGranule = page.granulePos;

    let tocSum = 0;
    for (const data of audioOnPage) {
      const frameSamples48k = opusPacketSamples48k(data);
      tocSum += frameSamples48k;
      packets.push({ data, frameSamples48k });
    }
    if (tocSum !== delta) throw new Error('granule mismatch');
  }

  if (!seenHead) throw new Error('Missing OpusHead');
  if (!seenTags) throw new Error('Missing OpusTags');
  if (!seenEos) throw new Error('Missing EOS on final page');
  return { packets, preSkip, inputSampleRate, channels, serial };
}

/**
 * Merge per-chunk Ogg Opus files from `muxOggOpus` into one continuous stream:
 * first chunk's OpusHead/OpusTags, all audio packets in order, one serial,
 * one BOS, one EOS, granulepos accumulated across chunk boundaries.
 *
 * Each chunk carries its own encoder priming (~preSkip samples), so
 * concatenation adds ~6.5 ms per boundary. Acceptable for meeting replay,
 * not sample-exact.
 */
export function remuxOggOpusChunks(chunks: ArrayBuffer[]): ArrayBuffer {
  if (chunks.length === 0) throw new Error('Nothing to remux');
  const first = parseOggOpus(chunks[0]!);
  const packets: OpusPacket[] = first.packets.slice();
  for (let i = 1; i < chunks.length; i++) {
    const parsed = parseOggOpus(chunks[i]!);
    for (const p of parsed.packets) packets.push(p);
  }
  return muxOggOpus(packets, {
    inputSampleRate: first.inputSampleRate,
    serial: first.serial,
    preSkip: first.preSkip,
    channels: first.channels,
  });
}

interface OggPage {
  headerType: number;
  granulePos: number;
  serial: number;
  sequence: number;
  packets: Uint8Array[];
}

function parseOpusHead(pkt: Uint8Array): {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
} {
  if (pkt.length < 19 || readAscii(pkt, 0, 8) !== OPUS_HEAD) {
    throw new Error('Missing OpusHead');
  }
  if (pkt[8] !== 1) throw new Error('Unsupported Opus version');
  const channels = pkt[9] ?? 0;
  if (channels !== 1 && channels !== 2) throw new Error('Unsupported channel count');
  if (pkt[18] !== 0) throw new Error('Unsupported channel mapping family');
  const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  return {
    channels,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
  };
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r;
  }
  return table;
}

/** Ogg CRC32: poly 0x04c11db7, init 0, no reflection, no final xor. */
function crc32Ogg(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    const idx = ((crc >>> 24) ^ b) & 0xff;
    crc = ((crc << 8) ^ (CRC_TABLE[idx] ?? 0)) >>> 0;
  }
  return crc >>> 0;
}

/** CRC of an Ogg page with the CRC field (bytes 22–25) treated as zero. */
function crc32OggPage(bytes: Uint8Array, off: number, size: number): number {
  let crc = 0;
  for (let i = 0; i < size; i++) {
    const b = i >= 22 && i < 26 ? 0 : (bytes[off + i] ?? 0);
    const idx = ((crc >>> 24) ^ b) & 0xff;
    crc = ((crc << 8) ^ (CRC_TABLE[idx] ?? 0)) >>> 0;
  }
  return crc >>> 0;
}

function writeAscii(bytes: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
}

function readAscii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i] ?? 0);
  return s;
}

function segmentCount(len: number): number {
  return Math.floor(len / 255) + 1;
}

function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const buf = new Uint8Array(19);
  const view = new DataView(buf.buffer);
  writeAscii(buf, 0, OPUS_HEAD);
  buf[8] = 1;
  buf[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true);
  buf[18] = 0;
  return buf;
}

function opusTags(): Uint8Array {
  const buf = new Uint8Array(8 + 4 + VENDOR.length + 4);
  const view = new DataView(buf.buffer);
  writeAscii(buf, 0, OPUS_TAGS);
  view.setUint32(8, VENDOR.length, true);
  writeAscii(buf, 12, VENDOR);
  view.setUint32(12 + VENDOR.length, 0, true);
  return buf;
}

function buildPage(
  packets: Uint8Array[],
  headerType: number,
  granulePos: number,
  serial: number,
  sequence: number,
): Uint8Array {
  const lacing: number[] = [];
  let payloadLen = 0;
  for (const p of packets) {
    payloadLen += p.length;
    let remaining = p.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  if (lacing.length > MAX_SEGMENTS) {
    throw new Error('Too many segments on Ogg page');
  }

  const headerSize = HEADER_BYTES + lacing.length;
  const page = new Uint8Array(headerSize + payloadLen);
  const view = new DataView(page.buffer);
  writeAscii(page, 0, OGG_CAPTURE);
  page[4] = 0;
  page[5] = headerType;
  view.setUint32(6, granulePos >>> 0, true);
  view.setUint32(10, Math.floor(granulePos / 0x100000000) >>> 0, true);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, sequence >>> 0, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) page[HEADER_BYTES + i] = lacing[i] ?? 0;

  let off = headerSize;
  for (const p of packets) {
    page.set(p, off);
    off += p.length;
  }
  view.setUint32(22, crc32Ogg(page), true);
  return page;
}

function concatPages(pages: Uint8Array[]): ArrayBuffer {
  let total = 0;
  for (const p of pages) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pages) {
    out.set(p, off);
    off += p.length;
  }
  return out.buffer;
}

function copyBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

function readPages(buf: ArrayBuffer): OggPage[] {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const pages: OggPage[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + HEADER_BYTES > bytes.length) throw new Error('Truncated Ogg page header');
    if (readAscii(bytes, off, 4) !== OGG_CAPTURE) {
      throw new Error('Invalid Ogg capture pattern');
    }
    const headerType = bytes[off + 5] ?? 0;
    const granulePos =
      view.getUint32(off + 6, true) + view.getUint32(off + 10, true) * 0x100000000;
    const serial = view.getUint32(off + 14, true);
    const sequence = view.getUint32(off + 18, true);
    const storedCrc = view.getUint32(off + 22, true);
    const nseg = bytes[off + 26] ?? 0;
    if (off + HEADER_BYTES + nseg > bytes.length) throw new Error('Truncated segment table');

    let payloadLen = 0;
    const lacing: number[] = [];
    for (let i = 0; i < nseg; i++) {
      const l = bytes[off + HEADER_BYTES + i] ?? 0;
      lacing.push(l);
      payloadLen += l;
    }
    const payloadOff = off + HEADER_BYTES + nseg;
    if (payloadOff + payloadLen > bytes.length) throw new Error('Truncated Ogg page payload');

    const pageSize = HEADER_BYTES + nseg + payloadLen;
    if (crc32OggPage(bytes, off, pageSize) !== storedCrc) {
      throw new Error('Ogg page CRC mismatch');
    }

    const packets: Uint8Array[] = [];
    const chunks: Uint8Array[] = [];
    let p = payloadOff;
    for (const l of lacing) {
      chunks.push(bytes.subarray(p, p + l));
      p += l;
      if (l < 255) {
        packets.push(joinChunks(chunks));
        chunks.length = 0;
      }
    }
    if (chunks.length > 0) {
      throw new Error('Continued packet across pages is not supported');
    }

    pages.push({ headerType, granulePos, serial, sequence, packets });
    off = payloadOff + payloadLen;
  }
  return pages;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return copyBytes(chunks[0]!);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
