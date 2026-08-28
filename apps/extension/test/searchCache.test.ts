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
});
