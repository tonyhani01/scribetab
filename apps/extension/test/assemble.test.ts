import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav } from '@scribetab/shared';
import { assembleRecording } from '../utils/assemble';
import { putChunk } from '../utils/chunkStore';
import { closeDb } from '../utils/db';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
});

afterEach(async () => {
  await closeDb();
  await deleteDb();
});

describe('assembleRecording', () => {
  it('returns a controlled empty result when no audio was retained', async () => {
    const result = await assembleRecording('missing');
    expect(result.seconds).toBe(0);
    expect(result.blob.size).toBe(0);
    expect(result.blob.type).toBe('audio/wav');
  });

  it('assembles retained chunks', async () => {
    const wav = encodeWav(new Float32Array(16), 16_000);
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav,
      createdAt: 1,
    });
    const result = await assembleRecording('s1');
    expect(result.seconds).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(44);
  });
});
