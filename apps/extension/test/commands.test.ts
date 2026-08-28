import { describe, expect, it } from 'vitest';
import { liveHighlightStartMs, normalizeHighlightLabel } from '../utils/commands';

describe('highlight command helpers', () => {
  it('normalizes labels by trimming, dropping empty text, and capping at 200 chars', () => {
    expect(normalizeHighlightLabel('  Important  ')).toBe('Important');
    expect(normalizeHighlightLabel('   ')).toBeUndefined();
    expect(normalizeHighlightLabel('x'.repeat(201))).toHaveLength(200);
    expect(normalizeHighlightLabel(undefined)).toBeUndefined();
  });

  it('only computes a timestamp for the live current session with a finite audio origin', () => {
    expect(liveHighlightStartMs('recording', 's1', 's1', 1_000, 2_500)).toBe(1_500);
    expect(liveHighlightStartMs('idle', 's1', 's1', 1_000, 2_500)).toBeNull();
    expect(liveHighlightStartMs('recording', 's2', 's1', 1_000, 2_500)).toBeNull();
    expect(liveHighlightStartMs('recording', 's1', 's1', Number.NaN, 2_500)).toBeNull();
  });
});
