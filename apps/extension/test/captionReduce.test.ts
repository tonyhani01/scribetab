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
    expect(r.state.blocks[0]).toMatchObject({ speaker: 'Ada', text: 'Hel', startMs: 1000, emitted: false });
  });

  it('coalesces in-place growth from the same speaker', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hel' }], 1000);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Ada', text: 'Hello team' }], 1100);
    expect(s.events).toEqual([]);
    expect(s.state.blocks[0]?.text).toBe('Hello team');
    expect(s.state.blocks[0]?.startMs).toBe(1000);
    expect(s.state.blocks[0]?.lastChangeMs).toBe(1100);
  });

  it('emits the previous caption when the speaker changes', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Bob', text: 'Hi' }], 1500);
    expect(s.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1001 },
    ]);
    expect(s.state.blocks[0]).toMatchObject({ speaker: 'Bob', text: 'Hi', startMs: 1500 });
  });

  it('emits on captions disappearing', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = applyCaptionSnapshots(s.state, [], 1800);
    expect(s.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1001 },
    ]);
    expect(s.state.blocks).toEqual([]);
  });

  it('tracks concurrent caption blocks from two speakers', () => {
    const r = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [
        { speaker: 'Ada', text: 'Earlier' },
        { speaker: 'Bob', text: 'Now' },
      ],
      50,
    );
    expect(r.events).toEqual([]);
    expect(r.state.blocks.map((b) => b.speaker)).toEqual(['Ada', 'Bob']);
    expect(r.state.blocks.map((b) => b.text)).toEqual(['Earlier', 'Now']);
  });

  it('does not drop a final update batched with the next block', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hel' }], 1000);
    s = applyCaptionSnapshots(
      s.state,
      [
        { speaker: 'Ada', text: 'Hello' },
        { speaker: 'Bob', text: 'Hi' },
      ],
      1100,
    );
    expect(s.events).toEqual([]);
    expect(s.state.blocks[0]).toMatchObject({ speaker: 'Ada', text: 'Hello', startMs: 1000, lastChangeMs: 1100 });
    expect(s.state.blocks[1]).toMatchObject({ speaker: 'Bob', text: 'Hi', startMs: 1100 });
    s = applyCaptionSnapshots(s.state, [], 2000);
    expect(s.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1100 },
      { speaker: 'Bob', text: 'Hi', timestampMs: 1100, endMs: 1101 },
    ]);
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
    expect(r.state.blocks[0]?.emitted).toBe(false);
  });

  it('emits once after text has been stable for idleMs using last mutation time as endMs', () => {
    const opened = applyCaptionSnapshots(
      EMPTY_CAPTION_STATE,
      [{ speaker: 'Ada', text: 'Hello' }],
      1000,
    );
    const r = stabilizeCaption(opened.state, 1000 + IDLE, IDLE);
    expect(r.events).toEqual([
      { speaker: 'Ada', text: 'Hello', timestampMs: 1000, endMs: 1001 },
    ]);
    expect(r.state.blocks[0]?.emitted).toBe(true);
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

  it('emits only new text after a stabilize when the block continues growing', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = stabilizeCaption(s.state, 1500, IDLE);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Ada', text: 'Hello there' }], 1600);
    expect(s.events).toEqual([]);
    expect(s.state.blocks[0]?.startMs).toBe(1600);
    expect(s.state.blocks[0]?.emitted).toBe(false);
    s = stabilizeCaption(s.state, 2000, IDLE);
    expect(s.events).toEqual([
      { speaker: 'Ada', text: 'there', timestampMs: 1600, endMs: 1601 },
    ]);
  });

  it('does not re-emit identical text after a container re-render', () => {
    let s = applyCaptionSnapshots(EMPTY_CAPTION_STATE, [{ speaker: 'Ada', text: 'Hello' }], 1000);
    s = stabilizeCaption(s.state, 1500, IDLE);
    s = applyCaptionSnapshots(s.state, [{ speaker: 'Ada', text: 'Hello' }], 1600);
    expect(s.events).toEqual([]);
    s = stabilizeCaption(s.state, 2200, IDLE);
    expect(s.events).toEqual([]);
  });
});
