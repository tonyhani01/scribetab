import { describe, expect, it } from 'vitest';
import { canApplySessionRead, type SessionReadToken } from '../utils/sessionReadGuard';
import { mergeSegments } from '../utils/segmentMerge';
import type { TranscriptSegment } from '@scribetab/shared';

describe('session read guard', () => {
  it('rejects a completed read after the user switched sessions', () => {
    const token: SessionReadToken = { sessionId: 'a', version: 1 };
    expect(canApplySessionRead(token, 'b', 2)).toBe(false);
  });

  it('accepts a read for the current session and request generation', () => {
    const token: SessionReadToken = { sessionId: 'a', version: 3 };
    expect(canApplySessionRead(token, 'a', 3)).toBe(true);
  });

  it('merges a slow base read with pushed rows, letting pushed ids win', () => {
    const base: TranscriptSegment[] = [
      { id: 'old', sessionId: 'a', startMs: 0, endMs: 1, text: 'old', source: 'audio' },
      { id: 'same', sessionId: 'a', startMs: 10, endMs: 11, text: 'stale', source: 'audio' },
    ];
    const pushed: TranscriptSegment[] = [
      { id: 'same', sessionId: 'a', startMs: 10, endMs: 11, text: 'fresh', source: 'audio' },
      { id: 'new', sessionId: 'a', startMs: 20, endMs: 21, text: 'new', source: 'audio' },
    ];
    expect(mergeSegments(base, pushed).map((row) => row.text)).toEqual(['old', 'fresh', 'new']);
  });
});
