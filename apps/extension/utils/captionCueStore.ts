import type { CaptionCue } from '@scribetab/shared';
import { CAPTIONS_STORE as STORE, openDb } from './db';

export interface CaptionCueRow extends CaptionCue {
  id: string;
  sessionId: string;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function putCue(row: CaptionCueRow): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(row);
  await txDone(tx);
}

export async function getCuesForSession(sessionId: string): Promise<CaptionCueRow[]> {
  const db = await openDb();
  const rows = await new Promise<CaptionCueRow[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('bySession').getAll(sessionId);
    req.onsuccess = () => resolve(req.result as CaptionCueRow[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export async function deleteCuesForSession(sessionId: string): Promise<void> {
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
