import { assembleWavChunks, parseOggOpus, remuxOggOpusChunks } from '@scribetab/shared';
import { getChunksForSession, type ChunkRow } from './chunkStore';

export async function assembleRecording(
  sessionId: string,
): Promise<{ blob: Blob; seconds: number; ext: 'wav' | 'ogg' }> {
  const rows = await getChunksForSession(sessionId);
  if (rows.length === 0) {
    // Retention/quota may have dropped audio while the session row remains.
    return { blob: new Blob([], { type: 'audio/wav' }), seconds: 0, ext: 'wav' };
  }
  if (rows.every((r) => r.format === 'ogg-opus')) {
    const buf = remuxOggOpusChunks(rows.map((r) => r.wav));
    return {
      blob: new Blob([buf], { type: 'audio/ogg' }),
      seconds: oggSeconds(rows, buf),
      ext: 'ogg',
    };
  }
  if (rows.every((r) => r.format !== 'ogg-opus')) {
    const buf = assembleWavChunks(rows);
    const sampleRate = rows[0]!.sampleRate;
    const dataLength = buf.byteLength - 44;
    return {
      blob: new Blob([buf], { type: 'audio/wav' }),
      seconds: dataLength / 2 / sampleRate,
      ext: 'wav',
    };
  }
  throw new Error('Recording mixes audio formats; download is unavailable for this session');
}

function oggSeconds(rows: ChunkRow[], remuxed: ArrayBuffer): number {
  if (rows.every((r) => typeof r.durationMs === 'number')) {
    let ms = 0;
    for (const r of rows) ms += r.durationMs ?? 0;
    return ms / 1000;
  }
  const parsed = parseOggOpus(remuxed);
  let samples = 0;
  for (const p of parsed.packets) samples += p.frameSamples48k;
  return samples / 48000;
}
