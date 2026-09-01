import { HIGHLIGHT_KINDS } from '@scribetab/shared';
import type { HighlightKind, HighlightMoment } from '@scribetab/shared';
import { openDb } from './db';

/**
 * Highlights live in their own IDB store, keyed [sessionId, startMs-indexed].
 * They are written live (during recording) and rendered in the side panel
 * plus markdown exports.
 */

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

/** Unknown or missing kinds (legacy rows, corrupted payloads) fall back to 'highlight'. */
export function normalizeHighlightKind(kind: unknown): HighlightKind {
  return HIGHLIGHT_KINDS.includes(kind as HighlightKind) ? (kind as HighlightKind) : 'highlight';
}

/** Reads backfill the default so legacy rows display and filter like new ones. */
function backfillKind(row: HighlightMoment): HighlightMoment {
  return { ...row, kind: normalizeHighlightKind(row.kind) };
}

export async function putHighlight(row: HighlightMoment): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('highlights', 'readwrite');
  tx.objectStore('highlights').put({ ...row, kind: normalizeHighlightKind(row.kind) });
  await txDone(tx);
}

export async function getHighlightsForSession(sessionId: string): Promise<HighlightMoment[]> {
  const db = await openDb();
  const rows = await new Promise<HighlightMoment[]>((resolve, reject) => {
    const tx = db.transaction('highlights', 'readonly');
    const req = tx.objectStore('highlights').index('bySession').getAll(sessionId);
    req.onsuccess = () => resolve(req.result as HighlightMoment[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.map(backfillKind).sort((a, b) => a.startMs - b.startMs);
}

export async function getAllHighlights(): Promise<HighlightMoment[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('highlights', 'readonly');
    const req = tx.objectStore('highlights').getAll();
    req.onsuccess = () => resolve((req.result as HighlightMoment[]).map(backfillKind));
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function deleteHighlight(sessionId: string, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('highlights', 'readwrite');
  const store = tx.objectStore('highlights');
  const getReq = store.get(id);
  getReq.onsuccess = () => {
    const row = getReq.result as HighlightMoment | undefined;
    if (row?.sessionId === sessionId) store.delete(id);
  };
  await txDone(tx);
}

export async function deleteHighlightsForSession(sessionId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('highlights', 'readwrite');
  const store = tx.objectStore('highlights');
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

export async function updateHighlightLabel(
  row: HighlightMoment,
  label: string | undefined,
): Promise<void> {
  const normalized = label?.trim().slice(0, 200) || undefined;
  await putHighlight({ ...row, label: normalized });
}
