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

export async function updateSegmentText(
  sessionId: string,
  segmentId: string,
  text: string,
): Promise<TranscriptSegment> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Transcript text cannot be empty');

  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const done = txDone(tx);
  const updated = await new Promise<TranscriptSegment>((resolve, reject) => {
    const getReq = store.get(segmentId);
    getReq.onsuccess = () => {
      const current = getReq.result as TranscriptSegment | undefined;
      if (!current || current.sessionId !== sessionId) {
        reject(new Error(`Segment not found: ${segmentId}`));
        tx.abort();
        return;
      }
      const next = { ...current, text: trimmed };
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  }).catch(async (error) => {
    await done.catch(() => {});
    throw error;
  });
  await done;
  return updated;
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
