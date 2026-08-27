import type { MeetingSession } from '@scribetab/shared';
import { deleteChunksForSession } from './chunkStore';
import { SESSIONS_STORE as STORE, openDb } from './db';
import { deleteSegmentsForSession } from './segmentStore';

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function createSession(session: MeetingSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).add(session);
  await txDone(tx);
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<MeetingSession, 'id'>>,
): Promise<void> {
  const current = await getSession(id);
  if (!current) throw new Error(`Session not found: ${id}`);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ ...current, ...patch, id });
  await txDone(tx);
}

export async function getSession(id: string): Promise<MeetingSession | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as MeetingSession | undefined);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function listSessions(): Promise<MeetingSession[]> {
  const db = await openDb();
  const rows = await new Promise<MeetingSession[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as MeetingSession[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Mark a recording session finished. Idempotent: a session that is already
 * complete/failed is left as-is. When `retainAudio` is false, that session's
 * audioChunks are deleted; segments and the session row always remain.
 */
export async function finalizeSession(
  id: string,
  opts: { retainAudio: boolean; status: 'complete' | 'failed' },
): Promise<void> {
  const session = await getSession(id);
  if (!session || session.status !== 'recording') return;
  await updateSession(id, { status: opts.status, endedAt: new Date().toISOString() });
  if (!opts.retainAudio) await deleteChunksForSession(id);
}

export async function deleteSession(id: string): Promise<void> {
  await deleteChunksForSession(id);
  await deleteSegmentsForSession(id);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

/** Abandoned 'recording' rows from a crashed SW/offscreen — never delete data. */
export async function failStaleRecordings(exceptId?: string): Promise<void> {
  const sessions = await listSessions();
  const now = new Date().toISOString();
  for (const s of sessions) {
    if (s.status !== 'recording') continue;
    if (exceptId && s.id === exceptId) continue;
    await updateSession(s.id, { status: 'failed', endedAt: s.endedAt ?? now });
  }
}
