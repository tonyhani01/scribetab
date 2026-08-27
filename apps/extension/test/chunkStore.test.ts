import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChunk, getChunksForSession, putChunk } from '../utils/chunkStore';
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

describe('chunkStore format field', () => {
  it('round-trips format and durationMs without a schema bump', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav: bytes,
      format: 'ogg-opus',
      durationMs: 12_000,
      createdAt: 1,
    });
    const row = await getChunk('s1', 0);
    expect(row?.format).toBe('ogg-opus');
    expect(row?.durationMs).toBe(12_000);
    expect(row?.sampleRate).toBe(16_000);
    expect(new Uint8Array(row!.wav)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await getChunksForSession('s1'))[0]?.format).toBe('ogg-opus');
  });

  it('leaves format undefined on legacy wav rows', async () => {
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 48_000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    const row = await getChunk('s1', 0);
    expect(row?.format).toBeUndefined();
    expect(row?.durationMs).toBeUndefined();
  });
});
