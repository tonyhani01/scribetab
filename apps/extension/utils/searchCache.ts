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
};

/**
 * Keeps the transcript search corpus in session-sized chunks. A library
 * refresh therefore only reads segments for sessions that were not previously
 * seen or have just finished recording.
 */
export class IncrementalSearchCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly loadSegments: SegmentLoader;

  constructor(loadSegments: SegmentLoader) {
    this.loadSegments = loadSegments;
  }

  async sync(sessions: readonly SearchCacheSession[]): Promise<SearchDoc[]> {
    const current = new Set(sessions.map((session) => session.id));
    for (const id of this.entries.keys()) {
      if (!current.has(id)) this.entries.delete(id);
    }

    await Promise.all(
      sessions.map(async (session) => {
        const prior = this.entries.get(session.id);
        const shouldLoad = !prior || (prior.status === 'recording' && session.status !== 'recording');
        if (shouldLoad) {
          const segments = (await this.loadSegments(session.id)).slice().sort((a, b) => a.startMs - b.startMs);
          this.entries.set(session.id, { title: session.title, status: session.status, segments });
          return;
        }
        // A rename must update result metadata but never reread unchanged
        // transcript segments.
        prior.title = session.title;
        prior.status = session.status;
      }),
    );
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
      this.entries.set(sessionId, {
        title: 'Untitled meeting',
        status: 'recording',
        segments: [...incoming].sort((a, b) => a.startMs - b.startMs),
      });
      return;
    }
    const byId = new Map(prior.segments.map((segment) => [segment.id, segment]));
    for (const segment of incoming) byId.set(segment.id, segment);
    prior.segments = [...byId.values()].sort((a, b) => a.startMs - b.startMs);
  }
}

export function createIncrementalSearchCache(loadSegments: SegmentLoader): IncrementalSearchCache {
  return new IncrementalSearchCache(loadSegments);
}
