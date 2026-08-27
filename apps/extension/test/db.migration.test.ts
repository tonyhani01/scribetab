import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAPTIONS_STORE, CHUNKS_STORE, SEGMENTS_STORE, SESSIONS_STORE, closeDb, openDb } from '../utils/db';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function openAt(
  version: number,
  onUpgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('scribetab', version);
    req.onupgradeneeded = () => onUpgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
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

describe('v2 → v3 upgrade', () => {
  it('drops legacy chunks and orphan segments and recreates v3 stores', async () => {
    const v2 = await openAt(2, (db) => {
      db.createObjectStore(CHUNKS_STORE, { keyPath: 'index' });
      const segs = db.createObjectStore(SEGMENTS_STORE, { keyPath: 'id' });
      segs.createIndex('bySession', 'sessionId', { unique: false });
    });
    const fill = v2.transaction([CHUNKS_STORE, SEGMENTS_STORE], 'readwrite');
    fill.objectStore(CHUNKS_STORE).put({
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    fill.objectStore(SEGMENTS_STORE).put({
      id: 'orphan',
      sessionId: 'no-such-session',
      startMs: 0,
      endMs: 1000,
      text: 'ghost',
      source: 'audio',
    });
    await txDone(fill);
    v2.close();

    const v3 = await openDb();
    expect([...v3.objectStoreNames].sort()).toEqual(
      [CAPTIONS_STORE, CHUNKS_STORE, SEGMENTS_STORE, SESSIONS_STORE].sort(),
    );

    const chunksStore = v3.transaction(CHUNKS_STORE, 'readonly').objectStore(CHUNKS_STORE);
    expect(chunksStore.keyPath).toEqual(['sessionId', 'index']);
    expect(chunksStore.indexNames.contains('bySession')).toBe(true);
    expect(chunksStore.indexNames.contains('wav')).toBe(false);
    expect([...chunksStore.indexNames]).toEqual(['bySession']);

    const leftoverSegs = await new Promise<unknown[]>((resolve, reject) => {
      const tx = v3.transaction(SEGMENTS_STORE, 'readonly');
      const req = tx.objectStore(SEGMENTS_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(leftoverSegs).toEqual([]);

    const leftoverChunks = await new Promise<unknown[]>((resolve, reject) => {
      const tx = v3.transaction(CHUNKS_STORE, 'readonly');
      const req = tx.objectStore(CHUNKS_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(leftoverChunks).toEqual([]);

    const write = v3.transaction([CHUNKS_STORE, SESSIONS_STORE, SEGMENTS_STORE], 'readwrite');
    write.objectStore(SESSIONS_STORE).add({
      id: 's1',
      title: 'n',
      startedAt: '2026-08-27T00:00:00.000Z',
      platform: 'other',
      status: 'complete',
    });
    write.objectStore(CHUNKS_STORE).add({
      sessionId: 's1',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    write.objectStore(SEGMENTS_STORE).add({
      id: 'seg',
      sessionId: 's1',
      startMs: 0,
      endMs: 10,
      text: 'ok',
      source: 'audio',
    });
    await txDone(write);
  });
});
