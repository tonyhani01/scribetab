import { describe, expect, it } from 'vitest';
import type { HighlightMoment, TranscriptSegment } from '@scribetab/shared';
import { loadOpenSessionData } from '../utils/openSessionData';

const segment: TranscriptSegment = {
  id: 'seg-1',
  sessionId: 's1',
  startMs: 0,
  endMs: 100,
  text: 'transcript',
  source: 'audio',
};
const highlight: HighlightMoment = {
  id: 'hl-1',
  sessionId: 's1',
  startMs: 50,
  createdAt: '2026-08-28T00:00:00.000Z',
};

describe('loadOpenSessionData', () => {
  it('keeps transcript data when the highlight read fails', async () => {
    const out = await loadOpenSessionData('s1', {
      loadSegments: async () => [segment],
      loadHighlights: async () => { throw new Error('highlights unavailable'); },
    });
    expect(out.segments).toEqual([segment]);
    expect(out.highlights).toEqual([]);
    expect(out.highlightsError).toEqual(new Error('highlights unavailable'));
  });

  it('keeps highlights when the transcript read fails', async () => {
    const out = await loadOpenSessionData('s1', {
      loadSegments: async () => { throw new Error('segments unavailable'); },
      loadHighlights: async () => [highlight],
    });
    expect(out.segments).toEqual([]);
    expect(out.highlights).toEqual([highlight]);
    expect(out.segmentsError).toEqual(new Error('segments unavailable'));
  });
});
