import { parseTranscriptFile, redactSegments, type MeetingSession, type SessionSummary } from '@scribetab/shared';
import { deleteCuesForSession } from './captionCueStore';
import { deleteChunksForSession } from './chunkStore';
import { SESSIONS_STORE as STORE, openDb } from './db';
import { deleteSegmentsForSession, putSegments, updateSegmentText } from './segmentStore';
import { deleteHighlightsForSession } from './highlightStore';

export type IntelligenceState = 'pending' | 'needs-permission';

/** Extension-side session row. Extra fields are not on the locked MeetingSession. */
export type StoredSession = MeetingSession & {
  archivedAt?: number;
  editedAt?: number;
  providerId?: string;
  model?: string;
  summaryMarkdown?: string;
  summary?: SessionSummary;
  actionExports?: Record<string, { destination: 'notion'; at: string }>;
  /** null = computed but unknown (UI: n/a). */
  costUsd?: number | null;
  /** Accrued provider-computed STT cost (e.g. OpenRouter usage.cost), STT-only. */
  providerCostUsd?: number;
  intelligence?: IntelligenceState | null;
  /** Why the last summary attempt failed (kept while intelligence stays pending). */
  intelligenceError?: string | null;
  /** Wall-clock ms when intelligence flipped to pending (elapsed-time indicator). */
  intelligenceStartedAt?: number;
  audioStartedAtMs?: number;
  captionsOnly?: boolean;
  /** Number of failed summary attempts, persisted for durable backoff. */
  intelligenceRetryCount?: number | null;
  /** Earliest wall-clock time at which the next summary attempt may run. */
  intelligenceNextRetryAt?: number | null;
  /** System labels computed at finalize (see autoLabel.ts); empty rows predate labeling. */
  labels?: string[];
};

const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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

export async function archiveSession(id: string, archivedAt = Date.now()): Promise<void> {
  await updateSession(id, { archivedAt });
}

export async function restoreSession(id: string): Promise<void> {
  await updateSession(id, { archivedAt: undefined });
}

/**
 * Redact-at-rest contract: when the setting is on, every LLM path assumes rows
 * on disk are already clean and skips redaction. Text entering storage from
 * outside the capture pipeline (user edits, file imports) must therefore be
 * redacted here, with the same extra terms the capture path uses.
 */
export interface AtRestRedaction {
  extraTerms: string[];
}

function redactText(text: string, redaction: AtRestRedaction | null | undefined): string {
  if (!redaction) return text;
  return redactSegments([{ text }], { extraTerms: redaction.extraTerms })[0]?.text ?? text;
}

export async function editSessionSegment(
  sessionId: string,
  segmentId: string,
  text: string,
  editedAt = Date.now(),
  redaction?: AtRestRedaction | null,
): Promise<Awaited<ReturnType<typeof updateSegmentText>>> {
  if (!(await getSession(sessionId))) throw new Error(`Session not found: ${sessionId}`);
  const updated = await updateSegmentText(sessionId, segmentId, redactText(text, redaction));
  await updateSession(sessionId, { editedAt });
  return updated;
}

export async function importTranscriptSession(
  name: string,
  content: string,
  redaction?: AtRestRedaction | null,
): Promise<{ sessionId: string } | { error: string }> {
  const parsed = parseTranscriptFile(name, content);
  if ('error' in parsed) return parsed;

  const sessionId = crypto.randomUUID();
  await createSession({
    id: sessionId,
    title: parsed.title,
    startedAt: new Date().toISOString(),
    platform: 'other',
    status: 'recording',
  });
  try {
    const clean = redaction
      ? redactSegments(parsed.segments, { extraTerms: redaction.extraTerms })
      : parsed.segments;
    await putSegments(
      clean.map((segment) => ({
        ...segment,
        id: crypto.randomUUID(),
        sessionId,
        source: 'captions' as const,
      })),
    );
    const finalized = await finalizeSession(sessionId, {
      retainAudio: false,
      status: 'complete',
    });
    if (!finalized) throw new Error('Imported session could not be finalized');
    return { sessionId };
  } catch (error) {
    await deleteSession(sessionId).catch(() => {});
    throw error;
  }
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
      const current = getReq.result as StoredSession | undefined;
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
  await deleteHighlightsForSession(id);
  await deleteCuesForSession(id);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

/** Permanently remove archives strictly older than the 30-day recovery window. */
export async function purgeExpiredArchivedSessions(now = Date.now()): Promise<number> {
  const cutoff = now - ARCHIVE_RETENTION_MS;
  const expired = (await listSessions()).filter(
    (session) => typeof session.archivedAt === 'number' && session.archivedAt < cutoff,
  );
  for (const session of expired) await deleteSession(session.id);
  return expired.length;
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
