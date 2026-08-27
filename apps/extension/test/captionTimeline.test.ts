import { describe, expect, it } from 'vitest';
import { appendCue, toSessionRelative } from '../utils/captionTimeline';

describe('toSessionRelative', () => {
  it('subtracts session start and clamps negative starts to 0', () => {
    expect(toSessionRelative(1_000, 1_500, 1_000)).toEqual({ startMs: 0, endMs: 500 });
    expect(toSessionRelative(900, 1_200, 1_000)).toEqual({ startMs: 0, endMs: 200 });
  });

  it('ensures endMs is at least startMs + 1', () => {
    expect(toSessionRelative(1_000, 1_000, 1_000)).toEqual({ startMs: 0, endMs: 1 });
  });
});

describe('appendCue', () => {
  it('returns a new array and does not mutate the input', () => {
    const cues = [{ speaker: 'Ada', text: 'hi', startMs: 0, endMs: 10 }];
    const next = appendCue(cues, { speaker: 'Bob', text: 'yo', startMs: 10, endMs: 20 });
    expect(cues).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(next[1]?.speaker).toBe('Bob');
  });
});
