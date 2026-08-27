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

/** Oldest completed session that still has audio — never recording/failed. */
export function nextSessionToDropAudio(
  sessions: readonly MeetingSession[],
  withAudio: ReadonlySet<string>,
): MeetingSession | undefined {
  return sessions
    .filter((s) => s.status === 'complete' && withAudio.has(s.id))
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
 * sessions (never segments or session rows) until usage is at or below 70%.
 */
export async function enforceQuota(
  estimate: () => Promise<{ usage: number; quota: number }>,
): Promise<QuotaReport> {
  const deletedSessionIds: string[] = [];
  let { usage, quota } = await estimate();
  let ratio = usageRatio(usage, quota);

  if (isOverWarn(ratio)) {
    const sessions = await listSessions();
    while (isOverTarget(ratio)) {
      const withAudio = new Set<string>();
      for (const s of sessions) {
        if (s.status !== 'complete') continue;
        if (deletedSessionIds.includes(s.id)) continue;
        if (await sessionHasChunks(s.id)) withAudio.add(s.id);
      }
      const victim = nextSessionToDropAudio(sessions, withAudio);
      if (!victim) break;
      await deleteChunksForSession(victim.id);
      deletedSessionIds.push(victim.id);
      ({ usage, quota } = await estimate());
      ratio = usageRatio(usage, quota);
    }
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
