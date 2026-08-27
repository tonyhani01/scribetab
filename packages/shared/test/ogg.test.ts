import { describe, it, expect } from 'vitest';
import {
  muxOggOpus,
  parseOggOpus,
  remuxOggOpusChunks,
  opusPacketSamples48k,
  type OpusPacket,
} from '../src/ogg';

/** Independent Ogg CRC32: bit-by-bit, poly 0x04c11db7, init 0, no reflect, no xorout. */
function oggCrc32Ref(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= ((data[i] ?? 0) << 24) >>> 0;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80000000) !== 0
        ? ((crc << 1) ^ 0x04c11db7) >>> 0
        : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

interface PageInfo {
  headerType: number;
  granulePos: number;
  serial: number;
  sequence: number;
  crc: number;
  lacing: number[];
  packets: Uint8Array[];
  bytes: Uint8Array;
}

function parsePages(buf: ArrayBuffer): PageInfo[] {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const pages: PageInfo[] = [];
  let off = 0;
  while (off < bytes.length) {
    const nseg = bytes[off + 26] ?? 0;
    const lacing: number[] = [];
    let payload = 0;
    for (let i = 0; i < nseg; i++) {
      const l = bytes[off + 27 + i] ?? 0;
      lacing.push(l);
      payload += l;
    }
    const size = 27 + nseg + payload;
    const pageBytes = bytes.subarray(off, off + size);
    const packets: Uint8Array[] = [];
    const chunks: Uint8Array[] = [];
    let p = off + 27 + nseg;
    for (const l of lacing) {
      chunks.push(bytes.subarray(p, p + l));
      p += l;
      if (l < 255) {
        let total = 0;
        for (const c of chunks) total += c.length;
        const pkt = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          pkt.set(c, o);
          o += c.length;
        }
        packets.push(pkt);
        chunks.length = 0;
      }
    }
    pages.push({
      headerType: bytes[off + 5] ?? 0,
      granulePos: view.getUint32(off + 6, true) + view.getUint32(off + 10, true) * 0x100000000,
      serial: view.getUint32(off + 14, true),
      sequence: view.getUint32(off + 18, true),
      crc: view.getUint32(off + 22, true),
      lacing,
      packets,
      bytes: pageBytes,
    });
    off += size;
  }
  return pages;
}

function ascii(u8: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...u8.subarray(off, off + len));
}

function pkt(bytes: number[], frameSamples48k = 960): OpusPacket {
  return { data: new Uint8Array(bytes), frameSamples48k };
}

const OPTS = { inputSampleRate: 16000, serial: 0x12345678 };

describe('Ogg CRC32', () => {
  // 32-byte page: OggS, ver 0, BOS, gran 0, serial 0x12345678, seq 0, crc 0,
  // 1 segment of 4, payload "test". Expected CRC derived with oggCrc32Ref.
  const CRC_PAGE = new Uint8Array([
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04,
    0x74, 0x65, 0x73, 0x74,
  ]);
  const EXPECTED_CRC = 0xf7708715;

  it('matches the hardcoded 32-byte page vector', () => {
    expect(CRC_PAGE.length).toBe(32);
    expect(oggCrc32Ref(CRC_PAGE)).toBe(EXPECTED_CRC);
  });

  it('matches muxer CRC fields on a real page', () => {
    const buf = muxOggOpus([pkt([1, 2, 3])], OPTS);
    for (const page of parsePages(buf)) {
      const zeroed = new Uint8Array(page.bytes);
      const dv = new DataView(zeroed.buffer, zeroed.byteOffset, zeroed.byteLength);
      dv.setUint32(22, 0, true);
      expect(oggCrc32Ref(zeroed)).toBe(page.crc);
    }
  });
});

describe('muxOggOpus headers', () => {
  it('writes OpusHead (BOS page 0) and OpusTags (page 1)', () => {
    const buf = muxOggOpus([], { ...OPTS, preSkip: 312, channels: 1 });
    const pages = parsePages(buf);
    expect(pages.length).toBe(2);

    const headPage = pages[0]!;
    expect(headPage.headerType & 0x02).toBe(0x02); // BOS
    expect(headPage.headerType & 0x04).toBe(0);    // not EOS
    expect(headPage.sequence).toBe(0);
    expect(headPage.granulePos).toBe(0);
    expect(headPage.serial).toBe(OPTS.serial);
    const head = headPage.packets[0]!;
    expect(ascii(head, 0, 8)).toBe('OpusHead');
    expect(head[8]).toBe(1);                       // version
    expect(head[9]).toBe(1);                       // channels
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(hv.getUint16(10, true)).toBe(312);
    expect(hv.getUint32(12, true)).toBe(16000);
    expect(hv.getInt16(16, true)).toBe(0);         // output gain
    expect(head[18]).toBe(0);                      // mapping family 0
    expect(head.length).toBe(19);

    const tagsPage = pages[1]!;
    expect(tagsPage.headerType & 0x02).toBe(0);
    expect(tagsPage.headerType & 0x04).toBe(0x04); // EOS when no audio
    expect(tagsPage.sequence).toBe(1);
    const tags = tagsPage.packets[0]!;
    expect(ascii(tags, 0, 8)).toBe('OpusTags');
    const tv = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
    expect(tv.getUint32(8, true)).toBe(9);
    expect(ascii(tags, 12, 9)).toBe('scribetab');
    expect(tv.getUint32(21, true)).toBe(0);        // zero user comments
  });

  it('defaults pre-skip to 312 and honors a custom value', () => {
    const def = parsePages(muxOggOpus([], OPTS))[0]!.packets[0]!;
    const dv = new DataView(def.buffer, def.byteOffset, def.byteLength);
    expect(dv.getUint16(10, true)).toBe(312);

    const custom = parsePages(muxOggOpus([], { ...OPTS, preSkip: 384 }))[0]!.packets[0]!;
    const cv = new DataView(custom.buffer, custom.byteOffset, custom.byteLength);
    expect(cv.getUint16(10, true)).toBe(384);
  });
});

describe('muxOggOpus audio pages', () => {
  it('sets BOS only on page 0, EOS only on the last page, and sequences from 0', () => {
    const buf = muxOggOpus([pkt([1]), pkt([2])], OPTS);
    const pages = parsePages(buf);
    expect(pages.length).toBe(3);
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i]!.sequence).toBe(i);
      expect(pages[i]!.serial).toBe(OPTS.serial);
    }
    expect(pages[0]!.headerType & 0x02).toBe(0x02);
    expect(pages.filter((p) => (p.headerType & 0x02) !== 0).length).toBe(1);
    expect(pages[pages.length - 1]!.headerType & 0x04).toBe(0x04);
    expect(pages.filter((p) => (p.headerType & 0x04) !== 0).length).toBe(1);
    expect(pages[1]!.headerType & 0x04).toBe(0);
  });

  it('accumulates granulepos in 48 kHz units regardless of input rate', () => {
    const buf = muxOggOpus(
      [pkt([1], 960), pkt([2], 960), pkt([3], 480)],
      { inputSampleRate: 16000, serial: 7 },
    );
    const audio = parsePages(buf).filter((p) => (p.headerType & 0x02) === 0 && p.sequence >= 2);
    expect(audio.length).toBe(1);
    expect(audio[0]!.granulePos).toBe(312 + 960 + 960 + 480);
  });

  it('laces a 255-byte packet as [255, 0] and a 510-byte packet as [255, 255, 0]', () => {
    const a = muxOggOpus([pkt(new Array(255).fill(9))], OPTS);
    const aPage = parsePages(a)[2]!;
    expect(aPage.lacing).toEqual([255, 0]);
    expect(aPage.packets[0]!.length).toBe(255);

    const b = muxOggOpus([pkt(new Array(510).fill(8))], OPTS);
    const bPage = parsePages(b)[2]!;
    expect(bPage.lacing).toEqual([255, 255, 0]);
    expect(bPage.packets[0]!.length).toBe(510);

    const c = muxOggOpus([pkt(new Array(256).fill(7))], OPTS);
    expect(parsePages(c)[2]!.lacing).toEqual([255, 1]);
  });

  it('caps a page at 255 segments', () => {
    const packets = Array.from({ length: 256 }, (_, i) => pkt([i & 0xff], 960));
    const pages = parsePages(muxOggOpus(packets, OPTS));
    const audio = pages.filter((p) => p.sequence >= 2);
    expect(audio[0]!.lacing.length).toBe(255);
    expect(audio[1]!.lacing.length).toBe(1);
    expect(audio[0]!.granulePos).toBe(312 + 255 * 960);
    expect(audio[1]!.granulePos).toBe(312 + 256 * 960);
    expect(audio[1]!.headerType & 0x04).toBe(0x04);
  });

  it('starts a new page before exceeding a 4 KB payload', () => {
    const packets = [pkt(new Array(3000).fill(1), 960), pkt(new Array(3000).fill(2), 960)];
    const audio = parsePages(muxOggOpus(packets, OPTS)).filter((p) => p.sequence >= 2);
    expect(audio.length).toBe(2);
    expect(audio[0]!.granulePos).toBe(312 + 960);
    expect(audio[1]!.granulePos).toBe(312 + 1920);
  });
});

describe('parseOggOpus', () => {
  it('round-trips packet bytes and TOC durations', () => {
    const packets = [pkt([1, 2, 3], 960), pkt([8], 960)];
    const parsed = parseOggOpus(muxOggOpus(packets, { ...OPTS, preSkip: 400, channels: 1 }));
    expect(parsed.preSkip).toBe(400);
    expect(parsed.inputSampleRate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect(parsed.serial).toBe(OPTS.serial);
    expect(parsed.packets.length).toBe(2);
    expect(Array.from(parsed.packets[0]!.data)).toEqual([1, 2, 3]);
    expect(Array.from(parsed.packets[1]!.data)).toEqual([8]);
    expect(parsed.packets[0]!.frameSamples48k).toBe(960);
    expect(parsed.packets[1]!.frameSamples48k).toBe(960);
  });
});

describe('remuxOggOpusChunks', () => {
  it('merges 3 chunks into one stream with packet identity and monotonic granulepos', () => {
    const c1 = muxOggOpus([pkt([1], 960)], { inputSampleRate: 16000, serial: 11, preSkip: 312 });
    const c2 = muxOggOpus([pkt([2, 2], 960)], { inputSampleRate: 16000, serial: 22 });
    const c3 = muxOggOpus([pkt([0, 3, 3], 480)], { inputSampleRate: 16000, serial: 33 });

    const out = remuxOggOpusChunks([c1, c2, c3]);
    const parsed = parseOggOpus(out);
    expect(parsed.packets.map((p) => Array.from(p.data))).toEqual([[1], [2, 2], [0, 3, 3]]);
    expect(parsed.serial).toBe(11);
    expect(parsed.preSkip).toBe(312);

    const pages = parsePages(out);
    expect(pages.filter((p) => (p.headerType & 0x02) !== 0).length).toBe(1);
    expect(pages[0]!.headerType & 0x02).toBe(0x02);
    expect(pages.filter((p) => (p.headerType & 0x04) !== 0).length).toBe(1);
    expect(pages[pages.length - 1]!.headerType & 0x04).toBe(0x04);
    for (let i = 0; i < pages.length; i++) expect(pages[i]!.sequence).toBe(i);
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);

    const audio = pages.filter((p) => p.sequence >= 2);
    let prev = 0;
    for (const p of audio) {
      expect(p.granulePos).toBeGreaterThan(prev);
      prev = p.granulePos;
    }
    expect(prev).toBe(312 + 960 + 960 + 480);
  });

  it('rejects an empty list', () => {
    expect(() => remuxOggOpusChunks([])).toThrow('Nothing to remux');
  });
});

/** SILK NB TOC: configs 0–3 = 10/20/40/60 ms. */
function silkNb(frameMs: 10 | 20 | 40 | 60, code: 0 | 1 | 2 | 3, m = 1): Uint8Array {
  const config = frameMs === 10 ? 0 : frameMs === 20 ? 1 : frameMs === 40 ? 2 : 3;
  const toc = (config << 3) | code;
  if (code === 3) return new Uint8Array([toc, m]);
  return new Uint8Array([toc]);
}

function concatBufs(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer.slice(0, out.byteLength) as ArrayBuffer;
}

function copyBuf(buf: ArrayBuffer): Uint8Array {
  const out = new Uint8Array(buf.byteLength);
  out.set(new Uint8Array(buf));
  return out;
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function pageOffset(pages: PageInfo[], index: number): number {
  let off = 0;
  for (let i = 0; i < index; i++) off += pages[i]!.bytes.length;
  return off;
}

function recomputePageCrc(bytes: Uint8Array, off: number, pageSize: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(off + 22, 0, true);
  view.setUint32(off + 22, oggCrc32Ref(bytes.subarray(off, off + pageSize)), true);
}

function makePage(
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
  const headerSize = 27 + lacing.length;
  const page = new Uint8Array(headerSize + payloadLen);
  const view = new DataView(page.buffer);
  for (let i = 0; i < 4; i++) page[i] = 'OggS'.charCodeAt(i);
  page[4] = 0;
  page[5] = headerType;
  view.setUint32(6, granulePos >>> 0, true);
  view.setUint32(10, Math.floor(granulePos / 0x100000000) >>> 0, true);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, sequence >>> 0, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) page[27 + i] = lacing[i] ?? 0;
  let off = headerSize;
  for (const p of packets) {
    page.set(p, off);
    off += p.length;
  }
  view.setUint32(22, oggCrc32Ref(page), true);
  return page;
}

describe('opusPacketSamples48k', () => {
  it('decodes 20 ms code-0/1/2/3 packets', () => {
    expect(opusPacketSamples48k(silkNb(20, 0))).toBe(960);
    expect(opusPacketSamples48k(silkNb(20, 1))).toBe(1920);
    expect(opusPacketSamples48k(silkNb(20, 2))).toBe(1920);
    expect(opusPacketSamples48k(silkNb(20, 3, 1))).toBe(960);
    expect(opusPacketSamples48k(silkNb(20, 3, 2))).toBe(1920);
  });

  it('decodes a 60 ms packet', () => {
    expect(opusPacketSamples48k(silkNb(60, 0))).toBe(2880);
  });

  it('throws when the packet exceeds 120 ms', () => {
    expect(() => opusPacketSamples48k(silkNb(20, 3, 7))).toThrow();
    expect(() => opusPacketSamples48k(silkNb(60, 3, 3))).toThrow();
  });

  it('throws on an empty packet', () => {
    expect(() => opusPacketSamples48k(new Uint8Array(0))).toThrow();
  });
});

describe('granulepos includes preSkip', () => {
  it('mux writes preSkip + cumulative samples and parse subtracts it', () => {
    const packets = [pkt([1, 2, 3], 960)];
    const buf = muxOggOpus(packets, { ...OPTS, preSkip: 400 });
    const audio = parsePages(buf).filter((p) => p.sequence >= 2);
    expect(audio[0]!.granulePos).toBe(400 + 960);
    const parsed = parseOggOpus(buf);
    expect(parsed.preSkip).toBe(400);
    expect(parsed.packets[0]!.frameSamples48k).toBe(960);
  });

  it('recovers mixed TOC durations on one page (not equal-split)', () => {
    const packets = [
      { data: silkNb(20, 0), frameSamples48k: 960 },
      { data: silkNb(60, 0), frameSamples48k: 2880 },
    ];
    const parsed = parseOggOpus(muxOggOpus(packets, OPTS));
    expect(parsed.packets.map((p) => p.frameSamples48k)).toEqual([960, 2880]);
  });

  it('throws on a granule/TOC mismatch', () => {
    expect(() =>
      parseOggOpus(muxOggOpus([{ data: silkNb(20, 0), frameSamples48k: 480 }], OPTS)),
    ).toThrow('granule mismatch');
  });
});

describe('parseOggOpus validation', () => {
  it('detects CRC corruption after flipping one payload byte', () => {
    const copy = copyBuf(muxOggOpus([pkt([1], 960)], OPTS));
    const last = copy.length - 1;
    copy[last] = (copy[last] ?? 0) ^ 1;
    expect(() => parseOggOpus(asArrayBuffer(copy))).toThrow('Ogg page CRC mismatch');
  });

  it('throws on concatenation of two muxed files (later BOS)', () => {
    const a = muxOggOpus([pkt([1], 960)], { ...OPTS, serial: 1 });
    const b = muxOggOpus([pkt([1], 960)], { ...OPTS, serial: 2 });
    expect(() => parseOggOpus(concatBufs(a, b))).toThrow(/BOS|serial/i);
  });

  it('throws when truncated before EOS', () => {
    const buf = muxOggOpus([pkt([1], 960)], OPTS);
    const pages = parsePages(buf);
    const last = pages[pages.length - 1]!;
    const truncated = buf.slice(0, buf.byteLength - last.bytes.length);
    expect(() => parseOggOpus(truncated)).toThrow();
  });

  it('throws on a page sequence gap', () => {
    const buf = muxOggOpus([pkt([1], 960)], OPTS);
    const pages = parsePages(buf);
    const copy = copyBuf(buf);
    const off = pageOffset(pages, 2);
    const view = new DataView(copy.buffer);
    view.setUint32(off + 18, 4, true);
    recomputePageCrc(copy, off, pages[2]!.bytes.length);
    expect(() => parseOggOpus(asArrayBuffer(copy))).toThrow('Ogg page sequence gap');
  });

  it('round-trips granulepos above 2^32 through the page codec', () => {
    const samples = 0x100000000 + 960;
    const buf = muxOggOpus([{ data: silkNb(20, 0), frameSamples48k: samples }], OPTS);
    const audio = parsePages(buf).filter((p) => p.sequence >= 2);
    expect(audio[0]!.granulePos).toBe(312 + samples);
    // TOC is 960, so parse must still *read* the 64-bit granule (else no mismatch).
    expect(() => parseOggOpus(buf)).toThrow('granule mismatch');
  });

  it('mux rejects channels: 3', () => {
    expect(() => muxOggOpus([pkt([1], 960)], { ...OPTS, channels: 3 })).toThrow();
  });

  it('rejects a zero-length packet in mux and parse', () => {
    expect(() =>
      muxOggOpus([{ data: new Uint8Array(0), frameSamples48k: 960 }], OPTS),
    ).toThrow('Zero-length Opus packet');

    const full = muxOggOpus([pkt([1], 960)], OPTS);
    const pages = parsePages(full);
    const emptyAudio = makePage([new Uint8Array(0)], 0x04, 312, OPTS.serial, 2);
    const out = new Uint8Array(pages[0]!.bytes.length + pages[1]!.bytes.length + emptyAudio.length);
    out.set(pages[0]!.bytes, 0);
    out.set(pages[1]!.bytes, pages[0]!.bytes.length);
    out.set(emptyAudio, pages[0]!.bytes.length + pages[1]!.bytes.length);
    expect(() => parseOggOpus(asArrayBuffer(out))).toThrow('Zero-length Opus packet');
  });
});
