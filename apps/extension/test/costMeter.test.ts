import { describe, expect, it } from 'vitest';
import { monthlySpend } from '../utils/costMeter';

function s(startedAt: string, costUsd?: number | null) {
  return { startedAt, costUsd };
}

describe('monthlySpend', () => {
  const now = new Date('2026-08-27T12:00:00Z');

  it('sums known costs for sessions started in the current month', () => {
    const out = monthlySpend(
      [s('2026-08-01T09:00:00Z', 0.12), s('2026-08-27T10:00:00Z', 0.3)],
      now,
    );
    expect(out).toEqual({ totalUsd: 0.42, sessionCount: 2, knownCount: 2 });
  });

  it('excludes sessions from other months and years', () => {
    const out = monthlySpend(
      [
        s('2026-07-15T12:00:00Z', 5),
        s('2025-08-15T12:00:00Z', 7),
        s('2026-08-10T09:00:00Z', 0.1),
      ],
      now,
    );
    expect(out).toEqual({ totalUsd: 0.1, sessionCount: 1, knownCount: 1 });
  });

  it('counts sessions with unknown cost without poisoning the total', () => {
    const out = monthlySpend(
      [s('2026-08-05T09:00:00Z', 0.2), s('2026-08-06T09:00:00Z', null), s('2026-08-07T09:00:00Z')],
      now,
    );
    expect(out).toEqual({ totalUsd: 0.2, sessionCount: 3, knownCount: 1 });
  });

  it('returns a zero total for an empty month', () => {
    expect(monthlySpend([], now)).toEqual({ totalUsd: 0, sessionCount: 0, knownCount: 0 });
  });

  it('ignores sessions with unparsable start dates', () => {
    const out = monthlySpend([s('not-a-date', 9), s('2026-08-10T09:00:00Z', 0.05)], now);
    expect(out).toEqual({ totalUsd: 0.05, sessionCount: 1, knownCount: 1 });
  });

  it('rounds away floating point noise', () => {
    const out = monthlySpend(
      [s('2026-08-01T00:00:00Z', 0.1), s('2026-08-02T00:00:00Z', 0.2)],
      now,
    );
    expect(out.totalUsd).toBe(0.3);
  });

  it('uses the local month boundary of the provided now', () => {
    // A session in the same local month as `now` counts even across UTC edges.
    const localNow = new Date(2026, 7, 1, 0, 30); // Aug 1 local time
    const inMonth = new Date(2026, 7, 15).toISOString();
    const out = monthlySpend([s(inMonth, 0.01)], localNow);
    expect(out.sessionCount).toBe(1);
  });
});
