import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { putChunk, getChunksForSession, sessionHasChunks } from '../utils/chunkStore';
import { closeDb } from '../utils/db';
import { getSegments, putSegments } from '../utils/segmentStore';
import {
  createSession,
  deleteSession,
  failStaleRecordings,
  finalizeSession,
  getSession,
  listSessions,
  updateSession,
} from '../utils/sessionStore';

const session = (over: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 's1',
  title: 'Standup',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'meet',
  status: 'recording',
  ...over,
});

const segment = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: 'seg1',
  sessionId: 's1',
  startMs: 0,
  endMs: 1000,
  text: 'hello',
  source: 'audio',
  ...over,
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

describe('sessionStore', () => {
  it('creates, gets, and lists newest first', async () => {
    await createSession(session({ id: 'old', startedAt: '2026-08-01T00:00:00.000Z' }));
    await createSession(session({ id: 'new', startedAt: '2026-08-27T00:00:00.000Z' }));
    expect((await getSession('new'))?.title).toBe('Standup');
    expect((await listSessions()).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('updateSession patches fields without changing id', async () => {
    await createSession(session());
    await updateSession('s1', { title: 'Renamed', status: 'complete' });
    const got = await getSession('s1');
    expect(got?.title).toBe('Renamed');
    expect(got?.id).toBe('s1');
    expect(got?.status).toBe('complete');
  });

  it('finalize keeps audio when retainAudio is true', async () => {
    await createSession(session());
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    await finalizeSession('s1', { retainAudio: true, status: 'complete' });
    const got = await getSession('s1');
    expect(got?.status).toBe('complete');
    expect(got?.endedAt).toBeTruthy();
    expect(await sessionHasChunks('s1')).toBe(true);
    expect((await getChunksForSession('s1')).length).toBe(1);
  });

  it('finalize deletes audioChunks but never segments when retainAudio is false', async () => {
    await createSession(session());
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    await putSegments([segment()]);
    await finalizeSession('s1', { retainAudio: false, status: 'complete' });
    expect(await sessionHasChunks('s1')).toBe(false);
    expect((await getSegments('s1')).map((s) => s.id)).toEqual(['seg1']);
    expect((await getSession('s1'))?.status).toBe('complete');
  });

  it('finalize is idempotent and does not rewrite endedAt on a completed session', async () => {
    await createSession(session());
    await finalizeSession('s1', { retainAudio: true, status: 'complete' });
    const first = await getSession('s1');
    await finalizeSession('s1', { retainAudio: true, status: 'failed' });
    const second = await getSession('s1');
    expect(second?.status).toBe('complete');
    expect(second?.endedAt).toBe(first?.endedAt);
  });

  it('deleteSession removes the row, its chunks, and its segments', async () => {
    await createSession(session());
    await createSession(session({ id: 's2', startedAt: '2026-08-28T00:00:00.000Z' }));
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    await putSegments([segment(), segment({ id: 'seg2', sessionId: 's2' })]);
    await deleteSession('s1');
    expect(await getSession('s1')).toBeUndefined();
    expect(await sessionHasChunks('s1')).toBe(false);
    expect(await getSegments('s1')).toEqual([]);
    expect((await getSession('s2'))?.id).toBe('s2');
    expect((await getSegments('s2')).map((s) => s.id)).toEqual(['seg2']);
  });

  it('failStaleRecordings marks abandoned recordings failed except the active id', async () => {
    await createSession(session({ id: 'stale' }));
    await createSession(session({ id: 'live', startedAt: '2026-08-28T00:00:00.000Z' }));
    await failStaleRecordings('live');
    expect((await getSession('stale'))?.status).toBe('failed');
    expect((await getSession('live'))?.status).toBe('recording');
  });

  it('finalize deletes audio for failed sessions when retainAudio is false', async () => {
    await createSession(session());
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    await finalizeSession('s1', { retainAudio: false, status: 'failed' });
    expect((await getSession('s1'))?.status).toBe('failed');
    expect(await sessionHasChunks('s1')).toBe(false);
  });

  it('crash sweep deletes audio when retainAudio is false', async () => {
    await createSession(session({ id: 'stale' }));
    await putChunk({
      sessionId: 'stale',
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
    await failStaleRecordings(undefined, false);
    expect((await getSession('stale'))?.status).toBe('failed');
    expect(await sessionHasChunks('stale')).toBe(false);
  });

  it('concurrent finalizeSession only one writer proceeds', async () => {
    await createSession(session());
    const results = await Promise.all([
      finalizeSession('s1', { retainAudio: true, status: 'complete' }),
      finalizeSession('s1', { retainAudio: true, status: 'failed' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const got = await getSession('s1');
    expect(got?.status === 'complete' || got?.status === 'failed').toBe(true);
  });
});
