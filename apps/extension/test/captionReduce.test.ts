import { describe, expect, it } from 'vitest';
import {
  EMPTY_CAPTION_STATE,
  applyCaptionSnapshots,
  stabilizeCaption,
} from '../utils/captionReduce';

const IDLE = 400;

describe('applyCaptionSnapshots', () => {
  it('opens an in-progress caption without emitting', () => {
    const r = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [{ speaker: 'Ada', text: 'Hel' }],
      1000,
    );
    expect(r.events).toEqual([]);
    expect(r.state.open).toMatchObject({ speaker: 'Ada', text: 'Hel', startMs: 1000, emitted: false });
  });

  it('coalesces in-place growth from the same speaker', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hel' }], 1000);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Ada', text: 'Hello team' }], 1100);
    expect(s.events).toEqual([]);
    expect(s.state.open?.text).toBe('Hello team');
    expect(s.state.open?.startMs).toBe(1000);
    expect(s.state.open?.lastChangeMs).toBe(1100);
  });

  it('emits the previous caption when the speaker changes', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Bob', text: 'Hi' }], 1500);
    expect(s.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1500 },
    ]);
    expect(s.state.open).toMatchObject({ speaker: 'Bob', text: 'Hi', startMs: 1500 });
  });

  it('emits on captions disappearing', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = applyCaptionSnapshots(s.state, [], 1800);
    expect(s.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1800 },
    ]);
    expect(s.state.open).toBeNull();
  });

  it('uses the last non-empty snapshot as the active caption', () => {
    const r = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [
        { speaker: 'Ada', text: 'Earlier' },
        { speaker: 'Bob', text: 'Now' },
      ],
      50,
    );
    expect(r.state.open?.speaker).toBe('Bob');
    expect(r.state.open?.text).toBe('Now');
  });
});

describe('stabilizeCaption', () => {
  it('does not emit before idleMs of unchanged text', () => {
    const opened = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [{ speaker: 'Ada', text: 'Hello' }],
      1000,
    );
    const r = stabilizeCaption(opened.state, 1000 + IDLE - 1, IDLE);
    expect(r.events).toEqual([]);
    expect(r.state.open?.emitted).toBe(false);
  });

  it('emits once after text has been stable for idleMs', () => {
    const opened = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [{ speaker: 'Ada', text: 'Hello' }],
      1000,
    );
    const r = stabilizeCaption(opened.state, 1000 + IDLE, IDLE);
    expect(r.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1400 },
    ]);
    expect(r.state.open?.emitted).toBe(true);
  });

  it('does not re-emit an already-emitted caption', () => {
    const opened = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [{ speaker: 'Ada', text: 'Hello' }],
      1000,
    );
    const first = stabilizeCaption(opened.state, 1500, IDLE);
    const second = stabilizeCaption(first.state, 2000, IDLE);
    expect(second.events).toEqual([]);
  });

  it('starts a new interval if text grows after a stabilize emit', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = stabilizeCaption(s.state, 1500, IDLE);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Ada', text: 'Hello there' }], 1600);
    expect(s.events).toEqual([]);
    expect(s.state.open?.startMs).toBe(1600);
    expect(s.state.open?.emitted).toBe(false);
  });
});
