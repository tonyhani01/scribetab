import { describe, expect, it } from 'vitest';
import { retentionCutoffMs, sessionsPastRetention } from '../src/retention';

describe('retention helpers', () => {
  it('computes seven- and thirty-day cutoffs and no cutoff forever', () => {
    const now = Date.parse('2026-08-28T00:00:00.000Z');
    expect(retentionCutoffMs(now, 7)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(retentionCutoffMs(now, 30)).toBe(now - 30 * 24 * 60 * 60 * 1000);
    expect(retentionCutoffMs(now, 'forever')).toBeNull();
  });

  it('skips recordings, sessions without chunks, invalid dates, and recent sessions', () => {
    const cutoff = Date.parse('2026-08-21T00:00:00.000Z');
    expect(sessionsPastRetention([
      { id: 'recording', status: 'recording', startedAt: '2026-08-01T00:00:00Z' },
      { id: 'no-chunks', status: 'complete', startedAt: '2026-08-01T00:00:00Z' },
      { id: 'invalid', status: 'complete', startedAt: 'not-a-date' },
      { id: 'recent', status: 'complete', startedAt: '2026-08-27T00:00:00Z' },
      { id: 'old', status: 'failed', startedAt: '2026-08-01T00:00:00Z' },
    ], new Set(['recording', 'invalid', 'recent', 'old']), cutoff)).toEqual(['old']);
  });
});
