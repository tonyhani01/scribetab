import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { getChunksForSession, putChunk } from '../utils/chunkStore';
import { closeDb } from '../utils/db';
import { getHighlightsForSession, putHighlight } from '../utils/highlightStore';
import { getSegments, putSegments } from '../utils/segmentStore';
import {
  archiveSession,
  createSession,
  getSession,
  purgeExpiredArchivedSessions,
  restoreSession,
} from '../utils/sessionStore';

const DAY_MS = 24 * 60 * 60 * 1_000;

const session = (over: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 's1',
  title: 'Standup',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'meet',
  status: 'complete',
  ...over,
});

const segment = (sessionId: string): TranscriptSegment => ({
  id: `seg-${sessionId}`,
  sessionId,
  startMs: 0,
  endMs: 1_000,
  text: 'hello',
  source: 'audio',
});

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
  await closeDb();
  await deleteDb();
});

describe('session archive', () => {
  it('sets and clears the archive timestamp without deleting the session', async () => {
    await createSession(session());

    await archiveSession('s1', 123_456);
    expect((await getSession('s1'))?.archivedAt).toBe(123_456);

    await restoreSession('s1');
    expect(await getSession('s1')).toMatchObject({ id: 's1', archivedAt: undefined });
  });

  it('purges archives older than 30 days through the full delete path', async () => {
    const now = Date.parse('2026-08-31T12:00:00.000Z');
    await createSession(session({ id: 'expired' }));
    await createSession(session({ id: 'boundary' }));
    await createSession(session({ id: 'active' }));
    await archiveSession('expired', now - 30 * DAY_MS - 1);
    await archiveSession('boundary', now - 30 * DAY_MS);
    await putChunk({
      sessionId: 'expired',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    await putSegments([segment('expired')]);
    await putHighlight({
      id: 'hl-expired',
      sessionId: 'expired',
      startMs: 100,
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    expect(await purgeExpiredArchivedSessions(now)).toBe(1);
    expect(await getSession('expired')).toBeUndefined();
    expect(await getChunksForSession('expired')).toEqual([]);
    expect(await getSegments('expired')).toEqual([]);
    expect(await getHighlightsForSession('expired')).toEqual([]);
    expect((await getSession('boundary'))?.archivedAt).toBe(now - 30 * DAY_MS);
    expect((await getSession('active'))?.id).toBe('active');
  });
});
