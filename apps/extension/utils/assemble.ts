import { assembleWavChunks } from '@scribetab/shared';
import { getChunksForSession } from './chunkStore';

export async function assembleRecording(
  sessionId: string,
): Promise<{ blob: Blob; seconds: number }> {
  const rows = await getChunksForSession(sessionId);
  if (rows.length === 0) {
    // Retention/quota may have dropped audio while the session row remains.
    return { blob: new Blob([], { type: 'audio/wav' }), seconds: 0 };
  }
  const buf = assembleWavChunks(rows);
  const sampleRate = rows[0]!.sampleRate;
  const dataLength = buf.byteLength - 44;
  return {
    blob: new Blob([buf], { type: 'audio/wav' }),
    seconds: dataLength / 2 / sampleRate,
  };
}
