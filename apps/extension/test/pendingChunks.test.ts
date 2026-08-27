import { describe, expect, it } from 'vitest';
import { addPending, clearPending, resolveBelow, resolvePending, type PendingChunk } from '../utils/pendingChunks';

function chunk(index: number, extra: Partial<PendingChunk> = {}): PendingChunk {
  return {
    chunkIndex: index,
    startMs: index * 12_000,
    durationMs: 12_000,
    startedAt: 1_000 + index,
    ...extra,
  };
}

describe('addPending', () => {
  it('inserts and keeps FIFO chunkIndex order', () => {
    const next = addPending(addPending([], chunk(2)), chunk(0));
    expect(next.map((p) => p.chunkIndex)).toEqual([0, 2]);
  });

  it('replaces an existing chunkIndex', () => {
    const first = chunk(1, { startMs: 100, startedAt: 10 });
    const updated = chunk(1, { startMs: 200, startedAt: 20 });
    expect(addPending([first], updated)).toEqual([updated]);
  });
});

describe('resolvePending', () => {
  it('removes the matching index and any earlier FIFO entries', () => {
    const pending = [chunk(0), chunk(1), chunk(2)];
    expect(resolvePending(pending, 1).map((p) => p.chunkIndex)).toEqual([2]);
  });

  it('is a no-op when the list is empty', () => {
    expect(resolvePending([], 0)).toEqual([]);
  });

  it('still drops earlier entries when the exact index is missing', () => {
    expect(resolvePending([chunk(0), chunk(2)], 1).map((p) => p.chunkIndex)).toEqual([2]);
  });
});

describe('resolveBelow', () => {
  it('drops entries with chunkIndex < count', () => {
    const pending = [chunk(0), chunk(1), chunk(2)];
    expect(resolveBelow(pending, 2).map((p) => p.chunkIndex)).toEqual([2]);
  });

  it('keeps entries whose chunkIndex equals count', () => {
    expect(resolveBelow([chunk(1), chunk(2)], 1).map((p) => p.chunkIndex)).toEqual([1, 2]);
  });

  it('is a no-op when count is 0', () => {
    const pending = [chunk(0), chunk(1)];
    expect(resolveBelow(pending, 0)).toEqual(pending);
  });

  it('is a no-op when the list is empty', () => {
    expect(resolveBelow([], 3)).toEqual([]);
  });
});

describe('clearPending', () => {
  it('returns an empty list', () => {
    expect(clearPending()).toEqual([]);
  });
});
