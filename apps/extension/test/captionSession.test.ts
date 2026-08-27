import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captionCueToSegment,
  captionCuesFor,
  clearCaptionTimeline,
  fuseWithCaptions,
  ingestCaptionEvent,
  rehydrateCaptionTimeline,
  resetCaptionTimeline,
} from '../utils/captionSession';
import { closeDb } from '../utils/db';
import type { TranscriptSegment } from '@scribetab/shared';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
});

afterEach(async () => {
  await clearCaptionTimeline('s1');
  await closeDb();
  await deleteDb();
});

describe('ingestCaptionEvent', () => {
  it('stores session-relative cues using the audio origin', async () => {
    resetCaptionTimeline('s1');
    await ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 5_000, endMs: 5_400 }, 5_000);
    expect(captionCuesFor('s1')).toEqual([
      { speaker: 'Ada', text: 'Hi', startMs: 0, endMs: 400 },
    ]);
  });

  it('drops cues from before the audio origin', async () => {
    resetCaptionTimeline('s1');
    const cue = await ingestCaptionEvent(
      's1',
      { speaker: 'Ada', text: 'Hi', timestampMs: 4_000, endMs: 4_400 },
      5_000,
    );
    expect(cue).toBeNull();
    expect(captionCuesFor('s1')).toEqual([]);
  });

  it('skips empty text', async () => {
    resetCaptionTimeline('s1');
    const cue = await ingestCaptionEvent('s1', { speaker: 'Ada', text: '  ', timestampMs: 5_000, endMs: 5_400 }, 5_000);
    expect(cue).toBeNull();
    expect(captionCuesFor('s1')).toEqual([]);
  });

  it('appends without copying the in-memory array', async () => {
    resetCaptionTimeline('s1');
    await ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 0, endMs: 10 }, 0);
    const first = captionCuesFor('s1');
    await ingestCaptionEvent('s1', { speaker: 'Bob', text: 'Yo', timestampMs: 10, endMs: 20 }, 0);
    expect(captionCuesFor('s1')).toBe(first);
    expect(first).toHaveLength(2);
  });

  it('rehydrates the in-memory timeline from IndexedDB', async () => {
    resetCaptionTimeline('s1');
    await ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 100, endMs: 200 }, 100);
    resetCaptionTimeline('s1');
    expect(captionCuesFor('s1')).toEqual([]);
    await rehydrateCaptionTimeline('s1');
    expect(captionCuesFor('s1')).toEqual([{ speaker: 'Ada', text: 'Hi', startMs: 0, endMs: 100 }]);
  });
});

describe('captionCueToSegment', () => {
  it('builds a captions-source segment', async () => {
    const cue = await ingestCaptionEvent(
      's1',
      { speaker: 'Ada', text: 'Hi', timestampMs: 10, endMs: 50 },
      10,
    );
    expect(cue).not.toBeNull();
    const seg = captionCueToSegment('s1', cue!, 'seg-1');
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
  it('attaches speakers onto audio segments from the session timeline', async () => {
    resetCaptionTimeline('s1');
    await ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 0, endMs: 1000 }, 0);
    const segments: TranscriptSegment[] = [
      { id: 'a', sessionId: 's1', startMs: 0, endMs: 1000, text: 'Hi', source: 'audio' },
    ];
    expect(fuseWithCaptions(segments, 's1')[0]?.speaker).toBe('Ada');
  });

  it('fuses with non-zero audio-origin skew', async () => {
    resetCaptionTimeline('s1');
    // Session created at 0; worklet starts at 2000; caption at wall 2500–3200 → 500–1200 relative.
    await ingestCaptionEvent('s1', { speaker: 'Ada', text: 'Hi', timestampMs: 2500, endMs: 3200 }, 2000);
    const segments: TranscriptSegment[] = [
      { id: 'a', sessionId: 's1', startMs: 0, endMs: 400, text: 'too early', source: 'audio' },
      { id: 'b', sessionId: 's1', startMs: 500, endMs: 1000, text: 'Hi', source: 'audio' },
    ];
    const out = fuseWithCaptions(segments, 's1');
    expect(out[0]?.speaker).toBeUndefined();
    expect(out[1]?.speaker).toBe('Ada');
  });
});
