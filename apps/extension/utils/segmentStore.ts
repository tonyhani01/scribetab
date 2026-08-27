import type { TranscriptSegment } from '@scribetab/shared';
import { SEGMENTS_STORE as STORE, openDb } from './db';

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function putSegments(segments: TranscriptSegment[]): Promise<void> {
  if (segments.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const s of segments) store.put(s);
  await txDone(tx);
}

export async function getSegments(sessionId: string): Promise<TranscriptSegment[]> {
  const db = await openDb();
  const rows = await new Promise<TranscriptSegment[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('bySession').getAll(sessionId);
    req.onsuccess = () => resolve(req.result as TranscriptSegment[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.sort((a, b) => a.startMs - b.startMs);
}

export async function getAllSegments(): Promise<TranscriptSegment[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as TranscriptSegment[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function deleteSegmentsForSession(sessionId: string): Promise<void> {
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
