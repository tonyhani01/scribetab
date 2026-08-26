import { wavHeader } from '@scribetab/shared';
import { getAllChunks } from './chunkStore';

/**
 * Concatenates stored WAV chunks into one file by stripping each 44-byte
 * header and prepending a single new one. Raw int16 bytes are copied as-is —
 * no decode/re-encode, no lossy requantization, no large float buffers.
 */
export async function assembleRecording(): Promise<{ blob: Blob; seconds: number }> {
  const rows = await getAllChunks(); // sorted by index
  if (rows.length === 0) throw new Error('Nothing recorded yet');

  const sampleRate = rows[0]!.sampleRate;
  const dataLength = rows.reduce((n, r) => n + (r.wav.byteLength - 44), 0);
  const out = new Uint8Array(44 + dataLength);
  out.set(new Uint8Array(wavHeader(dataLength, sampleRate)), 0);

  let off = 44;
  for (const r of rows) {
    out.set(new Uint8Array(r.wav, 44), off);
    off += r.wav.byteLength - 44;
  }
  return {
    blob: new Blob([out], { type: 'audio/wav' }),
    seconds: dataLength / 2 / sampleRate,
  };
}
