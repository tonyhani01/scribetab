import { roundUsd } from '@scribetab/shared';

export type MonthlySpend = {
  /** Sum of known session costs this month (0 when nothing is known). */
  totalUsd: number;
  /** Sessions started this month. */
  sessionCount: number;
  /** Sessions this month whose cost is a known number. */
  knownCount: number;
};

type CostRow = { startedAt: string; costUsd?: number | null };

/** Month-to-date spend across sessions, using local-time month boundaries. */
export function monthlySpend(sessions: readonly CostRow[], now: Date = new Date()): MonthlySpend {
  let totalUsd = 0;
  let sessionCount = 0;
  let knownCount = 0;
  for (const s of sessions) {
    const t = new Date(s.startedAt);
    if (Number.isNaN(t.getTime())) continue;
    if (t.getFullYear() !== now.getFullYear() || t.getMonth() !== now.getMonth()) continue;
    sessionCount += 1;
    if (typeof s.costUsd === 'number' && !Number.isNaN(s.costUsd)) {
      knownCount += 1;
      totalUsd += s.costUsd;
    }
  }
  return { totalUsd: roundUsd(totalUsd), sessionCount, knownCount };
}
