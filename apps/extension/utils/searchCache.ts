import type { TranscriptSegment } from '@scribetab/shared';
import { createSegmentIndex, type SearchDoc } from './search';

export type SearchCacheSession = {
  id: string;
  title: string;
  status: 'recording' | 'complete' | 'failed';
};

export type SegmentLoader = (sessionId: string) => Promise<TranscriptSegment[]>;

type CacheEntry = {
  title: string;
  status: SearchCacheSession['status'];
  segments: TranscriptSegment[];
  loaded: boolean;
  load?: Promise<void>;
  reloadAfterLoad: boolean;
  pushes: Map<string, { segment: TranscriptSegment; version: number }>;
};

/**
 * Keeps the transcript search corpus in session-sized chunks. A library
 * refresh therefore only reads segments for sessions that were not previously
 * seen or have just finished recording.
 */
export class IncrementalSearchCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly loadSegments: SegmentLoader;
  private pushVersion = 0;

  constructor(loadSegments: SegmentLoader) {
    this.loadSegments = loadSegments;
  }

  async sync(sessions: readonly SearchCacheSession[]): Promise<SearchDoc[]> {
    const current = new Set(sessions.map((session) => session.id));
    for (const id of this.entries.keys()) {
      if (!current.has(id)) this.entries.delete(id);
    }

    const loads: Promise<void>[] = [];
    for (const session of sessions) {
      const prior = this.entries.get(session.id);
      const statusTransition = prior?.status === 'recording' && session.status !== 'recording';
      const shouldLoad =
        !prior ||
        !prior.loaded ||
        statusTransition;
      const entry = prior ?? this.newEntry(session);
      // Metadata is updated synchronously, so a late result from an earlier
      // sync cannot restore an old title or status.
      entry.title = session.title;
      entry.status = session.status;
      if (shouldLoad) {
        if (entry.load && statusTransition) {
          entry.reloadAfterLoad = true;
        }
        loads.push(this.loadEntry(session.id, entry));
      }
    }
    await Promise.all(loads);
    return this.docs();
  }

  applySegmentsAdded(sessionId: string, segments: readonly TranscriptSegment[]): void {
    this.mergeSegments(sessionId, segments);
  }

  applySegmentsUpdated(sessionId: string, segments: readonly TranscriptSegment[]): void {
    this.mergeSegments(sessionId, segments);
  }

  applySegments(sessionId: string, segments: readonly TranscriptSegment[]): void {
    this.mergeSegments(sessionId, segments);
  }

  docs(): SearchDoc[] {
    const docs: SearchDoc[] = [];
    for (const [sessionId, entry] of this.entries) {
      for (const segment of entry.segments) {
        docs.push({
          id: segment.id,
          sessionId,
          startMs: segment.startMs,
          text: segment.text,
          sessionTitle: entry.title,
        });
      }
    }
    return docs;
  }

  createIndex() {
    return createSegmentIndex(this.docs());
  }

  private mergeSegments(sessionId: string, incoming: readonly TranscriptSegment[]): void {
    const prior = this.entries.get(sessionId);
    if (!prior) {
      const entry = this.newEntry({ id: sessionId, title: 'Untitled meeting', status: 'recording' });
      this.entries.set(sessionId, entry);
      for (const segment of incoming) {
        entry.pushes.set(segment.id, { segment, version: ++this.pushVersion });
      }
      entry.segments = [...incoming].sort((a, b) => a.startMs - b.startMs);
      return;
    }
    const byId = new Map(prior.segments.map((segment) => [segment.id, segment]));
    for (const segment of incoming) {
      byId.set(segment.id, segment);
      prior.pushes.set(segment.id, { segment, version: ++this.pushVersion });
    }
    prior.segments = [...byId.values()].sort((a, b) => a.startMs - b.startMs);
  }

  private newEntry(session: SearchCacheSession): CacheEntry {
    const entry: CacheEntry = {
      title: session.title,
      status: session.status,
      segments: [],
      loaded: false,
      reloadAfterLoad: false,
      pushes: new Map(),
    };
    this.entries.set(session.id, entry);
    return entry;
  }

  private loadEntry(sessionId: string, entry: CacheEntry): Promise<void> {
    if (entry.load) return entry.load;
    const load = (async () => {
      // A recording that completes while its first read is pending needs a
      // follow-up snapshot; coalescing the calls must not skip that transition.
      while (true) {
        const startedPushVersion = this.pushVersion;
        const loaded = await this.loadSegments(sessionId);
        // A deleted session may be re-created with the same ID while this read
        // is pending. Identity checking keeps this stale result out of the new
        // entry as well as out of a deleted one.
        if (this.entries.get(sessionId) !== entry) return;
        const merged = new Map(loaded.map((segment) => [segment.id, segment]));
        // Pushed rows may have arrived before this loader started (especially
        // for a session first seen through a live message), so retain every
        // pending push and let the push/update win by id.
        for (const { segment } of entry.pushes.values()) merged.set(segment.id, segment);
        entry.segments = [...merged.values()].sort((a, b) => a.startMs - b.startMs);
        for (const [id, pushed] of entry.pushes) {
          if (pushed.version <= startedPushVersion) entry.pushes.delete(id);
        }
        entry.loaded = true;
        if (!entry.reloadAfterLoad) return;
        entry.reloadAfterLoad = false;
        entry.loaded = false;
      }
    })();
    entry.load = load;
    const cleanup = () => {
      if (entry.load === load) entry.load = undefined;
    };
    load.then(cleanup, cleanup);
    return load;
  }
}

export function createIncrementalSearchCache(loadSegments: SegmentLoader): IncrementalSearchCache {
  return new IncrementalSearchCache(loadSegments);
}
