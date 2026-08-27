import { afterEach, describe, expect, it } from 'vitest';
import {
  captionCueToSegment,
  captionCuesFor,
  clearCaptionTimeline,
  fuseWithCaptions,
  ingestCaptionEvent,
  resetCaptionTimeline,
} from '../utils/captionSession';
import type { TranscriptSegment } from '@scribetab/shared';

afterEach(() => {
  clearCaptionTimeline('s1');
});

describe('ingestCaptionEvent', () => {
  it('stores session-relative cues', () => {
    resetCaptionTimeline('s1');
    ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 5_000, endMs: 5_400 }, 5_000);
    expect(captionCuesFor('s1')).toEqual([
      { speaker: 'Ada', text: 'Hi', startMs: 0, endMs: 400 },
    ]);
  });
});

describe('captionCueToSegment', () => {
  it('builds a captions-source segment', () => {
    const cue = ingestCaptionEvent(
      's1',
      { speaker: 'Ada', text: 'Hi', timestampMs: 10, endMs: 50 },
      10,
    );
    const seg = captionCueToSegment('s1', cue, 'seg-1');
    expect(seg).toEqual({
      id: 'seg-1',
      sessionId: 's1',
      startMs: 0,
      endMs: 40,
      text: 'Hi',
      speaker: 'Ada',
      source: 'captions',
    });
  });
});

describe('fuseWithCaptions', () => {
  it('attaches speakers onto audio segments from the session timeline', () => {
    resetCaptionTimeline('s1');
    ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 0, endMs: 1000 }, 0);
    const segments: TranscriptSegment[] = [
      { id: 'a', sessionId: 's1', startMs: 0, endMs: 1000, text: 'Hi', source: 'audio' },
    ];
    expect(fuseWithCaptions(segments, 's1')[0]?.speaker).toBe('Ada');
  });
});
