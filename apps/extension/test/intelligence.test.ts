import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from '@scribetab/shared';
import { putChunk } from '../utils/chunkStore';
import { closeDb } from '../utils/db';
import { runFinalizeIntelligence } from '../utils/intelligence';
import { getSegments, putSegments } from '../utils/segmentStore';
import { createSession, getSession } from '../utils/sessionStore';
import { DEFAULT_SETTINGS, type Settings } from '../utils/settings';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

beforeEach(async () => {
  await closeDb();
  await deleteDb();
  await createSession({
    id: 's1',
    title: 'Standup',
    startedAt: '2026-08-27T10:00:00.000Z',
    platform: 'meet',
    status: 'complete',
    endedAt: '2026-08-27T10:01:00.000Z',
  });
  await putSegments([
    {
      id: 'seg1',
      sessionId: 's1',
      startMs: 0,
      endMs: 1000,
      text: 'Ada at ada@example.com will ship. Call (415) 555-2671.',
      source: 'audio',
    },
  ]);
  const pcm = new Float32Array(16_000);
  await putChunk({
    sessionId: 's1',
    index: 0,
    sampleRate: 16_000,
    startOffsetSamples: 0,
    wav: encodeWav(pcm, 16_000),
    createdAt: 1,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  await deleteDb();
});

function stubChat(summary: string, actions: string) {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const content = user.startsWith('Summarize') ? summary : actions;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runFinalizeIntelligence', () => {
  it('stores summary, action items, and STT+LLM cost when an LLM is configured', async () => {
    const fetchMock = stubChat('Ship on Friday.', '- Ada ships');
    await runFinalizeIntelligence(
      's1',
      settings({
        providerId: 'openai',
        llmProviderId: 'openai',
        llmApiKey: 'sk-x',
      }),
    );
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toContain('## Summary');
    expect(got?.summaryMarkdown).toContain('Ship on Friday.');
    expect(got?.summaryMarkdown).toContain('- [ ] Ada ships');
    expect(got?.costUsd).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: { content: string }[];
    };
    expect(sent.messages.some((m) => m.content.includes('ada@example.com'))).toBe(false);
    expect(sent.messages.some((m) => m.content.includes('[EMAIL]'))).toBe(true);
  });

  it('redacts stored segments when redactAtRest is on', async () => {
    stubChat('ok', '- none');
    await runFinalizeIntelligence(
      's1',
      settings({
        llmProviderId: 'openai',
        llmApiKey: 'sk-x',
        redactAtRest: true,
        redactTerms: ['Ada'],
      }),
    );
    const segs = await getSegments('s1');
    expect(segs[0]?.text).toContain('[EMAIL]');
    expect(segs[0]?.text).toContain('[PHONE]');
    expect(segs[0]?.text).toContain('[REDACTED]');
    expect(segs[0]?.text).not.toContain('ada@example.com');
  });

  it('still records STT cost when no LLM is configured', async () => {
    await runFinalizeIntelligence('s1', settings({ providerId: 'openai' }));
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toBeUndefined();
    expect(got?.costUsd).toBe(0.0001); // 1s of OpenAI Whisper
  });

  it('keeps STT cost if the LLM call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await runFinalizeIntelligence(
      's1',
      settings({ providerId: 'openai', llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toBeUndefined();
    expect(got?.costUsd).toBe(0.0001);
  });
});
