import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../src/types';
import { UNKNOWN_SPEAKER, computeTalkTime, segmentDurationMs } from '../src/talkTime';

const segment = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: 'seg',
  sessionId: 's1',
  startMs: 0,
  endMs: 1000,
  text: 'hello',
  speaker: 'Ada',
  source: 'captions',
  ...over,
});

describe('segmentDurationMs', () => {
  it('is endMs minus startMs', () => {
    expect(segmentDurationMs(segment({ startMs: 1500, endMs: 9000 }))).toBe(7500);
  });
  it('clamps inverted spans to zero', () => {
    expect(segmentDurationMs(segment({ startMs: 5000, endMs: 1000 }))).toBe(0);
  });
  it('is zero for non-finite bounds', () => {
    expect(segmentDurationMs({ startMs: Number.NaN, endMs: 1000 })).toBe(0);
    expect(segmentDurationMs({ startMs: 0, endMs: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe('computeTalkTime', () => {
  it('sums each speaker\'s segment durations and percentages', () => {
    const rows = computeTalkTime([
      segment({ speaker: 'Ada', startMs: 0, endMs: 30_000 }),
      segment({ speaker: 'Bo', startMs: 30_000, endMs: 40_000 }),
      segment({ speaker: 'Ada', startMs: 40_000, endMs: 50_000 }),
    ]);
    expect(rows).toEqual([
      { speaker: 'Ada', ms: 40_000, pct: 80 },
      { speaker: 'Bo', ms: 10_000, pct: 20 },
    ]);
  });
  it('sorts by most talk time first, then by name', () => {
    const rows = computeTalkTime([
      segment({ speaker: 'Cy', startMs: 0, endMs: 5000 }),
      segment({ speaker: 'Bo', startMs: 0, endMs: 9000 }),
      segment({ speaker: 'Ada', startMs: 0, endMs: 9000 }),
    ]);
    expect(rows.map((r) => r.speaker)).toEqual(['Ada', 'Bo', 'Cy']);
  });
  it('groups missing, empty and whitespace speakers under Unknown', () => {
    const rows = computeTalkTime([
      segment({ speaker: undefined, startMs: 0, endMs: 4000 }),
      segment({ speaker: '   ', startMs: 0, endMs: 2000 }),
      segment({ speaker: 'Ada', startMs: 0, endMs: 4000 }),
    ]);
    expect(rows).toEqual([
      { speaker: UNKNOWN_SPEAKER, ms: 6000, pct: 60 },
      { speaker: 'Ada', ms: 4000, pct: 40 },
    ]);
  });
  it('trims speaker names for grouping', () => {
    const rows = computeTalkTime([
      segment({ speaker: ' Ada ', startMs: 0, endMs: 1000 }),
      segment({ speaker: 'Ada', startMs: 1000, endMs: 3000 }),
    ]);
    expect(rows).toEqual([{ speaker: 'Ada', ms: 3000, pct: 100 }]);
  });
  it('rounds percentages to one decimal', () => {
    const rows = computeTalkTime([
      segment({ speaker: 'Ada', startMs: 0, endMs: 2000 }),
      segment({ speaker: 'Bo', startMs: 0, endMs: 1000 }),
    ]);
    expect(rows.find((r) => r.speaker === 'Bo')?.pct).toBe(33.3);
    expect(rows.find((r) => r.speaker === 'Ada')?.pct).toBe(66.7);
  });
  it('ignores zero-length and malformed segments', () => {
    const rows = computeTalkTime([
      segment({ speaker: 'Ada', startMs: 1000, endMs: 1000 }),
      segment({ speaker: 'Bo', startMs: 5000, endMs: 2000 }),
      segment({ speaker: 'Cy', startMs: 0, endMs: 6000 }),
    ]);
    expect(rows).toEqual([{ speaker: 'Cy', ms: 6000, pct: 100 }]);
  });
  it('returns an empty list for no usable talk time', () => {
    expect(computeTalkTime([])).toEqual([]);
    expect(computeTalkTime([segment({ startMs: 10, endMs: 5 })])).toEqual([]);
  });
});
