import { muxOggOpus, opusPacketSamples48k, type OpusPacket } from '@scribetab/shared';

const OPUS_RATE = 16_000;
const FRAME_SAMPLES_16K = 320; // 20 ms at 16 kHz
const ENCODE_TIMEOUT_MS = 10_000;

/** WebCodecs Opus config. `format: 'opus'` is the spec default (raw packets). */
const OPUS_CONFIG = {
  codec: 'opus',
  sampleRate: OPUS_RATE,
  numberOfChannels: 1,
  bitrate: 16_000,
  opus: { usedtx: true },
};

/** First isConfigSupported result; subsequent chunks reuse it. */
let opusSupported: boolean | undefined;

/**
 * True when encoded packets cover the 16 kHz input within one 20 ms frame
 * (encoder padding of a final partial frame). Empty or DTX-short streams fail.
 */
export function opusPacketsCoverInput(
  packets: ReadonlyArray<{ frameSamples48k: number }>,
  inputSamples16k: number,
): boolean {
  if (packets.length === 0) return false;
  let sum = 0;
  for (const p of packets) sum += p.frameSamples48k;
  const expected48k = inputSamples16k * 3;
  return Math.abs(sum - expected48k) <= 960;
}

/**
 * Encode 16 kHz mono PCM to a standalone Ogg Opus file.
 * Returns null when WebCodecs is missing, the config is unsupported, encode
 * fails, packets don't cover the input, or the 10 s timeout fires.
 * One AudioEncoder per call; caller owns fallback policy.
 */
export async function encodeChunkToOggOpus(
  pcm16k: Float32Array,
  serial = 0,
): Promise<ArrayBuffer | null> {
  const g = globalThis as typeof globalThis & {
    AudioEncoder?: typeof AudioEncoder;
    AudioData?: typeof AudioData;
  };
  if (typeof g.AudioEncoder !== 'function' || typeof g.AudioData !== 'function') {
    return null;
  }
  const AudioEncoderCtor = g.AudioEncoder;
  const AudioDataCtor = g.AudioData;

  let aborted = false;
  let closeEncoder = (): void => {};

  const encode = async (): Promise<ArrayBuffer | null> => {
    try {
      if (opusSupported === undefined) {
        const support = await AudioEncoderCtor.isConfigSupported(
          OPUS_CONFIG as unknown as AudioEncoderConfig,
        );
        opusSupported = !!support.supported;
      }
      if (aborted || !opusSupported) return null;

      const packets: OpusPacket[] = [];
      let failed = false;
      const encoder = new AudioEncoderCtor({
        output(chunk) {
          if (aborted || chunk.byteLength === 0) return;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          packets.push({
            data,
            frameSamples48k: opusPacketSamples48k(data),
          });
        },
        error() {
          failed = true;
        },
      });
      closeEncoder = () => {
        if (encoder.state !== 'closed') {
          try {
            encoder.close();
          } catch {
            // already closed
          }
        }
      };
      if (aborted) {
        closeEncoder();
        return null;
      }

      encoder.configure(OPUS_CONFIG as unknown as AudioEncoderConfig);
      let timestamp = 0;
      for (let i = 0; i < pcm16k.length; i += FRAME_SAMPLES_16K) {
        if (aborted) return null;
        const n = Math.min(FRAME_SAMPLES_16K, pcm16k.length - i);
        const frame = pcm16k.slice(i, i + n);
        const audio = new AudioDataCtor({
          format: 'f32-planar',
          sampleRate: OPUS_RATE,
          numberOfFrames: n,
          numberOfChannels: 1,
          timestamp,
          data: frame,
        });
        encoder.encode(audio);
        audio.close();
        timestamp += Math.round((n * 1_000_000) / OPUS_RATE);
      }
      await encoder.flush();
      if (aborted || failed) return null;
      if (!opusPacketsCoverInput(packets, pcm16k.length)) return null;
      return muxOggOpus(packets, { inputSampleRate: OPUS_RATE, serial });
    } catch {
      return null;
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      encode(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ENCODE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    aborted = true;
    if (timer !== undefined) clearTimeout(timer);
    closeEncoder();
  }
}
