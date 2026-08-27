import type { MeetingSession } from '@scribetab/shared';
import { deleteChunksForSession } from './chunkStore';
import { SESSIONS_STORE as STORE, openDb } from './db';
import { deleteSegmentsForSession } from './segmentStore';

/** Extension-side session row. Extra fields are not on the locked MeetingSession. */
export type StoredSession = MeetingSession & {
  summaryMarkdown?: string;
  costUsd?: number;
};

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function createSession(session: StoredSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).add(session);
  await txDone(tx);
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<StoredSession, 'id'>>,
): Promise<void> {
  const current = await getSession(id);
  if (!current) throw new Error(`Session not found: ${id}`);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ ...current, ...patch, id });
  await txDone(tx);
}

export async function getSession(id: string): Promise<StoredSession | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as StoredSession | undefined);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function listSessions(): Promise<StoredSession[]> {
  const db = await openDb();
  const rows = await new Promise<StoredSession[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredSession[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Mark a recording session finished. Idempotent: the status check-and-flip
 * happens in one readwrite transaction so concurrent finalizers cannot both
 * proceed. When `retainAudio` is false, that session's audioChunks are deleted
 * for both complete and failed outcomes; segments and the session row remain.
 */
export async function finalizeSession(
  id: string,
  opts: { retainAudio: boolean; status: 'complete' | 'failed' },
): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const flipped = await new Promise<boolean>((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const current = getReq.result as MeetingSession | undefined;
      if (!current || current.status !== 'recording') {
        resolve(false);
        return;
      }
      store.put({
        ...current,
        status: opts.status,
        endedAt: new Date().toISOString(),
        id,
      });
      resolve(true);
    };
    getReq.onerror = () => reject(getReq.error);
  });
  await txDone(tx);
  if (flipped && !opts.retainAudio) await deleteChunksForSession(id);
  return flipped;
}

export async function deleteSession(id: string): Promise<void> {
  await deleteChunksForSession(id);
  await deleteSegmentsForSession(id);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

/** Abandoned 'recording' rows from a crashed SW/offscreen. */
export async function failStaleRecordings(exceptId?: string, retainAudio = true): Promise<void> {
  const sessions = await listSessions();
  for (const s of sessions) {
    if (s.status !== 'recording') continue;
    if (exceptId && s.id === exceptId) continue;
    await finalizeSession(s.id, { retainAudio, status: 'failed' });
  }
}
