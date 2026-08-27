import { describe, expect, it } from 'vitest';
import { fuseSpeakers, type CaptionCue } from '../src/fusion';
import type { TranscriptSegment } from '../src/types';

function seg(over: Partial<TranscriptSegment> & Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>): TranscriptSegment {
  return {
    sessionId: 's1',
    text: over.text ?? over.id,
    source: 'audio',
    ...over,
  };
}

function cue(over: Partial<CaptionCue> & Pick<CaptionCue, 'speaker' | 'startMs' | 'endMs'>): CaptionCue {
  return {
    text: over.text ?? over.speaker,
    ...over,
  };
}

describe('fuseSpeakers', () => {
  it('attaches the speaker whose caption overlaps the segment', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000, text: 'hello' })];
    const captions = [cue({ speaker: 'Ada', startMs: 0, endMs: 1000, text: 'hello' })];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBe('Ada');
  });

  it('uses majority-overlap when multiple speakers cover one segment', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000, text: 'long turn' })];
    const captions = [
      cue({ speaker: 'Ada', startMs: 0, endMs: 700 }),
      cue({ speaker: 'Bob', startMs: 700, endMs: 1000 }),
    ];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBe('Ada');
  });

  it('leaves speaker undefined when captions only touch the segment at an endpoint (adjacent)', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const captions = [cue({ speaker: 'Ada', startMs: 1000, endMs: 2000 })];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBeUndefined();
  });

  it('leaves speaker undefined when there is a gap and no overlap', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const captions = [cue({ speaker: 'Ada', startMs: 1500, endMs: 2000 })];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBeUndefined();
  });

  it('sums split overlaps for the same speaker across a gap inside the segment', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const captions = [
      cue({ speaker: 'Ada', startMs: 0, endMs: 200 }),
      cue({ speaker: 'Ada', startMs: 800, endMs: 1000 }),
      cue({ speaker: 'Bob', startMs: 200, endMs: 500 }),
    ];
    // Ada 400ms vs Bob 300ms
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBe('Ada');
  });

  it('does not mutate the input arrays or segment objects', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const captions = [cue({ speaker: 'Ada', startMs: 0, endMs: 1000 })];
    const frozenSeg = { ...segments[0]! };
    fuseSpeakers(segments, captions);
    expect(segments[0]).toEqual(frozenSeg);
    expect(segments[0]?.speaker).toBeUndefined();
  });

  it('returns a new array even when nothing changes', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const out = fuseSpeakers(segments, []);
    expect(out).not.toBe(segments);
    expect(out[0]).not.toBe(segments[0]);
    expect(out[0]?.speaker).toBeUndefined();
  });

  it('keeps an existing speaker when no caption overlaps (does not invent or strip)', () => {
    const segments = [seg({ id: 'c', startMs: 0, endMs: 1000, speaker: 'Ada', source: 'captions' })];
    const out = fuseSpeakers(segments, []);
    expect(out[0]?.speaker).toBe('Ada');
  });

  it('overwrites an audio speaker when captions have majority overlap', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000, speaker: 'Wrong' })];
    const captions = [cue({ speaker: 'Ada', startMs: 0, endMs: 1000 })];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBe('Ada');
  });

  it('ignores captions with empty speaker or inverted timestamps', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const captions = [
      cue({ speaker: '', startMs: 0, endMs: 1000 }),
      cue({ speaker: 'Ada', startMs: 800, endMs: 100 }),
    ];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBeUndefined();
  });

  it('breaks equal-overlap ties by earliest caption start', () => {
    const segments = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const captions = [
      cue({ speaker: 'Bob', startMs: 500, endMs: 1000 }),
      cue({ speaker: 'Ada', startMs: 0, endMs: 500 }),
    ];
    expect(fuseSpeakers(segments, captions)[0]?.speaker).toBe('Ada');
  });

  it('fuses a list of segments independently', () => {
    const segments = [
      seg({ id: 'a', startMs: 0, endMs: 1000 }),
      seg({ id: 'b', startMs: 1000, endMs: 2000 }),
      seg({ id: 'c', startMs: 5000, endMs: 6000 }),
    ];
    const captions = [
      cue({ speaker: 'Ada', startMs: 0, endMs: 1000 }),
      cue({ speaker: 'Bob', startMs: 1000, endMs: 2000 }),
    ];
    const out = fuseSpeakers(segments, captions);
    expect(out.map((s) => s.speaker)).toEqual(['Ada', 'Bob', undefined]);
  });
});
