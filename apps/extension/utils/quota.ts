import type { MeetingSession } from '@scribetab/shared';
import { deleteChunksForSession, sessionHasChunks } from './chunkStore';
import { listSessions } from './sessionStore';

export const WARN_RATIO = 0.8;
export const TARGET_RATIO = 0.7;

export function usageRatio(usage: number, quota: number): number {
  if (!(quota > 0)) return 0;
  return usage / quota;
}

export function isOverWarn(ratio: number): boolean {
  return ratio > WARN_RATIO;
}

export function isOverTarget(ratio: number): boolean {
  return ratio > TARGET_RATIO;
}

function hasDroppableAudio(s: MeetingSession): boolean {
  return s.status === 'complete' || s.status === 'failed';
}

/** Oldest completed or failed session that still has audio — never recording. */
export function nextSessionToDropAudio(
  sessions: readonly MeetingSession[],
  withAudio: ReadonlySet<string>,
): MeetingSession | undefined {
  return sessions
    .filter((s) => hasDroppableAudio(s) && withAudio.has(s.id))
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))[0];
}

export interface QuotaReport {
  usage: number;
  quota: number;
  ratio: number;
  warning: boolean;
  deletedSessionIds: string[];
}

/**
 * If usage is above 80% of quota, delete audioChunks of the oldest completed
 * or failed sessions (never segments or session rows) until usage is at or
 * below 70%. Stops if a deletion does not reduce estimated usage.
 */
export async function enforceQuota(
  estimate: () => Promise<{ usage: number; quota: number }>,
): Promise<QuotaReport> {
  const deletedSessionIds: string[] = [];
  let { usage, quota } = await estimate();
  let ratio = usageRatio(usage, quota);

  if (isOverWarn(ratio)) {
    const sessions = await listSessions();
    const withAudio = new Set<string>();
    for (const s of sessions) {
      if (!hasDroppableAudio(s)) continue;
      if (await sessionHasChunks(s.id)) withAudio.add(s.id);
    }
    while (isOverTarget(ratio)) {
      const victim = nextSessionToDropAudio(sessions, withAudio);
      if (!victim) break;
      const usageBefore = usage;
      await deleteChunksForSession(victim.id);
      withAudio.delete(victim.id);
      deletedSessionIds.push(victim.id);
      ({ usage, quota } = await estimate());
      if (!(usage < usageBefore)) break;
      ratio = usageRatio(usage, quota);
    }
    ratio = usageRatio(usage, quota);
  }

  const warning = isOverWarn(ratio);
  await chrome.storage.local.set({ quotaWarning: warning });
  return { usage, quota, ratio, warning, deletedSessionIds };
}

export async function checkQuota(): Promise<QuotaReport> {
  return enforceQuota(async () => {
    if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  });
}
