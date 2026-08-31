import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { closeDb } from '../utils/db';
import { getSegments, putSegments, updateSegmentText } from '../utils/segmentStore';
import { createSession, editSessionSegment, getSession } from '../utils/sessionStore';

const session = (over: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 's1',
  title: 'Standup',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'meet',
  status: 'complete',
  ...over,
});

const segment = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: 'seg1',
  sessionId: 's1',
  startMs: 0,
  endMs: 1_000,
  text: 'Original text',
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
  await createSession(session());
  await putSegments([segment()]);
});

afterEach(async () => {
  await closeDb();
  await deleteDb();
});

describe('segment text editing', () => {
  it('persists trimmed text and marks the session edited', async () => {
    await editSessionSegment('s1', 'seg1', '  Corrected wording  ', 987_654);

    expect((await getSegments('s1'))[0]).toMatchObject({
      id: 'seg1',
      text: 'Corrected wording',
      startMs: 0,
      endMs: 1_000,
      source: 'audio',
    });
    expect((await getSession('s1'))?.editedAt).toBe(987_654);
  });

  it('rejects whitespace without changing the segment or session', async () => {
    await expect(editSessionSegment('s1', 'seg1', '  \n\t  ', 987_654)).rejects.toThrow(
      'Transcript text cannot be empty',
    );

    expect((await getSegments('s1'))[0]?.text).toBe('Original text');
    expect((await getSession('s1'))?.editedAt).toBeUndefined();
  });

  it('does not update a segment that belongs to another session', async () => {
    await expect(updateSegmentText('other-session', 'seg1', 'Wrong meeting')).rejects.toThrow(
      'Segment not found',
    );
    expect((await getSegments('s1'))[0]?.text).toBe('Original text');
  });
});
