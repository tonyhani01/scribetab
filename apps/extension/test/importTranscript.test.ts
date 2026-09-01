import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChunksForSession } from '../utils/chunkStore';
import { closeDb } from '../utils/db';
import { getSegments } from '../utils/segmentStore';
import { getSession, importTranscriptSession, listSessions } from '../utils/sessionStore';

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

describe('transcript import persistence', () => {
  it('parses a file into a finalized text-only session', async () => {
    const result = await importTranscriptSession(
      'customer-call.srt',
      `1
00:00:01,000 --> 00:00:03,000
Ada: Welcome aboard.

2
00:00:03,500 --> 00:00:04,500
Thanks!`,
    );

    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(await getSession(result.sessionId)).toMatchObject({
      id: result.sessionId,
      title: 'customer-call',
      platform: 'other',
      status: 'complete',
      endedAt: expect.any(String),
    });
    expect(await getSegments(result.sessionId)).toEqual([
      expect.objectContaining({
        sessionId: result.sessionId,
        speaker: 'Ada',
        text: 'Welcome aboard.',
        startMs: 1_000,
        endMs: 3_000,
        source: 'captions',
      }),
      expect.objectContaining({
        sessionId: result.sessionId,
        text: 'Thanks!',
        startMs: 3_500,
        endMs: 4_500,
        source: 'captions',
      }),
    ]);
    expect(await getChunksForSession(result.sessionId)).toEqual([]);
  });

  it('returns the parser error without creating a partial session', async () => {
    const result = await importTranscriptSession('broken.vtt', 'not a VTT transcript');

    expect(result).toEqual({ error: 'Could not parse VTT transcript' });
    expect(await listSessions()).toEqual([]);
  });
});

describe('redact-at-rest on import', () => {
  it('redacts PII in imported segments when redaction is passed', async () => {
    const result = await importTranscriptSession(
      'call.srt',
      `1
00:00:01,000 --> 00:00:03,000
Reach me at ada@example.com about Project Nightfall.`,
      { extraTerms: ['Project Nightfall'] },
    );
    if ('error' in result) throw new Error(result.error);
    const [seg] = await getSegments(result.sessionId);
    expect(seg.text).not.toContain('ada@example.com');
    expect(seg.text).not.toContain('Project Nightfall');
    expect(seg.text).toContain('[EMAIL]');
    expect(seg.text).toContain('[REDACTED]');
  });

  it('stores text verbatim when no redaction is passed', async () => {
    const result = await importTranscriptSession(
      'call.srt',
      `1
00:00:01,000 --> 00:00:03,000
Reach me at ada@example.com.`,
    );
    if ('error' in result) throw new Error(result.error);
    const [seg] = await getSegments(result.sessionId);
    expect(seg.text).toContain('ada@example.com');
  });
});
