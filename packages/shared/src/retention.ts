/**
 * Audio retention policy. 'forever' keeps audio until the IndexedDB quota
 * eviction kicks in; a number means auto-delete chunks older than that many
 * days after the session is complete.
 */
export type RetentionDays = 7 | 30 | 'forever';

export const RETENTION_CHOICES: readonly RetentionDays[] = [7, 30, 'forever'];

export function isRetentionDays(v: unknown): v is RetentionDays {
  return v === 7 || v === 30 || v === 'forever';
}

export function retentionLabel(v: RetentionDays): string {
  if (v === 'forever') return 'Keep until storage runs low';
  return `Auto-delete audio after ${v} days`;
}

/** Cutoff Date.now() ms before which completed-session audio may be swept. */
export function retentionCutoffMs(nowMs: number, retention: RetentionDays): number | null {
  if (retention === 'forever') return null;
  return nowMs - retention * 24 * 60 * 60 * 1000;
}

/**
 * Sessions whose audio is past the retention window. Only complete/failed
 * sessions are ever swept — never the recording in progress. Caller supplies
 * whether each session still has chunks (keeps this pure).
 */
export function sessionsPastRetention(
  sessions: readonly { id: string; status: string; startedAt: string; endedAt?: string }[],
  hasChunks: ReadonlySet<string>,
  cutoffMs: number | null,
): string[] {
  if (cutoffMs == null) return [];
  const out: string[] = [];
  for (const s of sessions) {
    if (s.status !== 'complete' && s.status !== 'failed') continue;
    if (!hasChunks.has(s.id)) continue;
    const ref = s.endedAt ?? s.startedAt;
    const t = Date.parse(ref);
    if (!Number.isFinite(t)) continue;
    if (t <= cutoffMs) out.push(s.id);
  }
  return out;
}
