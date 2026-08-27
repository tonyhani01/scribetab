import { describe, expect, it } from 'vitest';
import { appendCue, toSessionRelative } from '../utils/captionTimeline';

describe('toSessionRelative', () => {
  it('subtracts the audio origin', () => {
    expect(toSessionRelative(1_000, 1_500, 1_000)).toEqual({ startMs: 0, endMs: 500 });
  });

  it('drops cues that start before the audio origin instead of clamping', () => {
    expect(toSessionRelative(900, 1_200, 1_000)).toBeNull();
    expect(toSessionRelative(999, 2_000, 1_000)).toBeNull();
  });

  it('converts with non-zero skew (audio starts after session create)', () => {
    expect(toSessionRelative(5_300, 5_800, 5_000)).toEqual({ startMs: 300, endMs: 800 });
  });

  it('ensures endMs is at least startMs + 1', () => {
    expect(toSessionRelative(1_000, 1_000, 1_000)).toEqual({ startMs: 0, endMs: 1 });
  });
});

describe('appendCue', () => {
  it('appends in place without copying the array', () => {
    const cues = [{ speaker: 'Ada', text: 'hi', startMs: 0, endMs: 10 }];
    const next = appendCue(cues, { speaker: 'Bob', text: 'yo', startMs: 10, endMs: 20 });
    expect(next).toBe(cues);
    expect(cues).toHaveLength(2);
    expect(cues[1]?.speaker).toBe('Bob');
  });

  it('refuses empty-text cues', () => {
    const cues = [{ speaker: 'Ada', text: 'hi', startMs: 0, endMs: 10 }];
    appendCue(cues, { speaker: 'Bob', text: '  ', startMs: 10, endMs: 20 });
    expect(cues).toHaveLength(1);
  });
});
