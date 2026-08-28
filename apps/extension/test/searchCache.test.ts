import { describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '@scribetab/shared';
import { createIncrementalSearchCache } from '../utils/searchCache';

const segment = (id: string, sessionId: string, text: string, startMs = 0): TranscriptSegment => ({
  id,
  sessionId,
  startMs,
  endMs: startMs + 100,
  text,
  source: 'audio',
});

const session = (id: string, status: 'recording' | 'complete' | 'failed', title = id) => ({
  id,
  title,
  status,
  startedAt: '2026-08-28T00:00:00.000Z',
  platform: 'meet' as const,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('incremental search cache', () => {
  it('loads each session once, reloads recording sessions on completion, and drops deleted sessions', async () => {
    const rows = new Map<string, TranscriptSegment[]>([
      ['s1', [segment('a', 's1', 'first')]],
      ['s2', [segment('b', 's2', 'second')]],
    ]);
    const load = vi.fn(async (id: string) => rows.get(id) ?? []);
    const cache = createIncrementalSearchCache(load);

    await cache.sync([session('s1', 'complete'), session('s2', 'recording')]);
    await cache.sync([session('s1', 'complete'), session('s2', 'recording')]);
    expect(load).toHaveBeenCalledTimes(2);

    rows.set('s2', [segment('b', 's2', 'finished')]);
    await cache.sync([session('s1', 'complete'), session('s2', 'complete')]);
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.docs().map((doc) => doc.sessionId)).toEqual(['s1', 's2']);

    await cache.sync([session('s2', 'complete')]);
    expect(cache.docs().map((doc) => doc.sessionId)).toEqual(['s2']);
  });

  it('updates titles without reloading segments and accepts pushed segment changes', async () => {
    const load = vi.fn(async () => [segment('a', 's1', 'old')]);
    const cache = createIncrementalSearchCache(load);
    await cache.sync([session('s1', 'complete', 'Before')]);

    await cache.sync([session('s1', 'complete', 'After')]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.docs()[0]).toMatchObject({ sessionTitle: 'After', text: 'old' });

    cache.applySegmentsAdded('s1', [segment('b', 's1', 'new', 100)]);
    cache.applySegmentsUpdated('s1', [segment('a', 's1', 'updated')]);
    const index = cache.createIndex();
    expect(index.search('new')[0]?.sessionTitle).toBe('After');
    expect(index.search('updated')[0]?.id).toBe('a');
  });

  it('loads a newly added session even when the cache was already synced', async () => {
    const load = vi.fn(async (id: string) => [segment(id + '-seg', id, id)]);
    const cache = createIncrementalSearchCache(load);
    await cache.sync([session('s1', 'complete')]);
    await cache.sync([session('s1', 'complete'), session('s2', 'complete')]);
    expect(load.mock.calls.map(([id]) => id)).toEqual(['s1', 's2']);
  });

  it('merges pushed segments that arrive while a session load is in flight', async () => {
    const pending = deferred<TranscriptSegment[]>();
    const cache = createIncrementalSearchCache(vi.fn(() => pending.promise));
    const syncing = cache.sync([session('s1', 'complete')]);
    cache.applySegmentsAdded('s1', [segment('pushed', 's1', 'from live')]);
    pending.resolve([segment('loaded', 's1', 'from storage')]);
    await syncing;
    expect(cache.docs().map((doc) => doc.id)).toEqual(['loaded', 'pushed']);
  });

  it('coalesces overlapping syncs and keeps the newest session metadata', async () => {
    const pending = deferred<TranscriptSegment[]>();
    const load = vi.fn(() => pending.promise);
    const cache = createIncrementalSearchCache(load);
    const first = cache.sync([session('s1', 'complete', 'old title')]);
    const second = cache.sync([session('s1', 'complete', 'new title')]);
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve([segment('a', 's1', 'text')]);
    await Promise.all([first, second]);
    expect(cache.docs()[0]).toMatchObject({ sessionTitle: 'new title' });
  });

  it('does not let a stale load reintroduce a deleted session', async () => {
    const pending = deferred<TranscriptSegment[]>();
    const cache = createIncrementalSearchCache(vi.fn(() => pending.promise));
    const syncing = cache.sync([session('s1', 'complete')]);
    await cache.sync([]);
    pending.resolve([segment('a', 's1', 'stale')]);
    await syncing;
    expect(cache.docs()).toEqual([]);
  });

  it('reloads after a pending recording load when the session becomes complete', async () => {
    const first = deferred<TranscriptSegment[]>();
    const second = deferred<TranscriptSegment[]>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const cache = createIncrementalSearchCache(load);
    const recording = cache.sync([session('s1', 'recording')]);
    const complete = cache.sync([session('s1', 'complete')]);
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve([segment('old', 's1', 'partial')]);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve([segment('new', 's1', 'complete')]);
    await Promise.all([recording, complete]);
    expect(cache.docs().map((doc) => doc.id)).toEqual(['new']);
  });

  it('preserves pushed data that exists before an initial loader starts', async () => {
    const pending = deferred<TranscriptSegment[]>();
    const cache = createIncrementalSearchCache(vi.fn(() => pending.promise));
    cache.applySegmentsAdded('s1', [segment('pushed', 's1', 'from live')]);
    const syncing = cache.sync([session('s1', 'recording')]);
    pending.resolve([]);
    await syncing;
    expect(cache.docs().map((doc) => doc.id)).toEqual(['pushed']);
  });
});
