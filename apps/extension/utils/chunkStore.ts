import { CHUNKS_STORE as STORE, openDb } from './db';

export interface ChunkRow {
  sessionId: string;
  index: number;
  sampleRate: number;
  startOffsetSamples: number; // cumulative samples before this chunk (session-relative timing)
  wav: ArrayBuffer;
  createdAt: number;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function putChunk(row: ChunkRow): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(row);
  await txDone(tx);
}

export async function getChunksForSession(sessionId: string): Promise<ChunkRow[]> {
  const db = await openDb();
  const rows = await new Promise<ChunkRow[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('bySession').getAll(sessionId);
    req.onsuccess = () => resolve(req.result as ChunkRow[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.sort((a, b) => a.index - b.index);
}

export async function deleteChunksForSession(sessionId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const keysReq = store.index('bySession').getAllKeys(sessionId);
  await new Promise<void>((resolve, reject) => {
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) store.delete(key);
    };
    keysReq.onerror = () => reject(keysReq.error);
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function getChunk(sessionId: string, index: number): Promise<ChunkRow | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get([sessionId, index]);
    req.onsuccess = () => resolve(req.result as ChunkRow | undefined);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function listChunkIndexes(sessionId: string): Promise<number[]> {
  const db = await openDb();
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('bySession').getAllKeys(sessionId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const indexes: number[] = [];
  for (const key of keys) {
    if (Array.isArray(key) && typeof key[1] === 'number') indexes.push(key[1]);
  }
  return indexes.sort((a, b) => a - b);
}

export async function sessionHasChunks(sessionId: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('bySession').count(sessionId);
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
