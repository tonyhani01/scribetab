import { assembleWavChunks } from '@scribetab/shared';
import { getChunksForSession } from './chunkStore';

export async function assembleRecording(sessionId: string): Promise<{ blob: Blob; seconds: number }> {
  const rows = await getChunksForSession(sessionId);
  const buf = assembleWavChunks(rows);
  const sampleRate = rows[0]!.sampleRate;
  const dataLength = buf.byteLength - 44;
  return {
    blob: new Blob([buf], { type: 'audio/wav' }),
    seconds: dataLength / 2 / sampleRate,
  };
}
