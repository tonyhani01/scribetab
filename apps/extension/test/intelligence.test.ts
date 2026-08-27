import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSegments } from '@scribetab/shared';
import { closeDb } from '../utils/db';
import {
  retryPendingIntelligence,
  runFinalizeIntelligence,
  scheduleFinalizeIntelligence,
} from '../utils/intelligence';
import { deleteSegmentsForSession, getSegments, putSegments } from '../utils/segmentStore';
import { createSession, getSession, updateSession } from '../utils/sessionStore';
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

function stubChrome(opts: { contains?: boolean; settings?: Settings } = {}) {
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn().mockResolvedValue(opts.contains ?? true),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ settings: opts.settings ?? DEFAULT_SETTINGS }),
      },
    },
  });
}

beforeEach(async () => {
  stubChrome();
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
      speaker: 'Ada ada@example.com',
      source: 'audio',
    },
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  await deleteDb();
});

function stubChat(narrative: string, actionLine = '') {
  const text = actionLine.replace(/^[-*]\s*/, '').trim();
  const actionItems = text && !/^none\b/i.test(text) ? [{ text }] : [];
  const content = JSON.stringify({
    narrative,
    actionItems,
    decisions: [],
    usefulInfo: [],
  });
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  );
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
    expect(got?.intelligence).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: { content: string }[];
    };
    expect(sent.messages.some((m) => m.content.includes('ada@example.com'))).toBe(false);
    expect(sent.messages.some((m) => m.content.includes('[EMAIL]'))).toBe(true);
    expect(sent.messages.some((m) => m.content.includes('Ada ada@example.com'))).toBe(false);
  });

  it('sends openai requests to api.openai.com even when llmBaseUrl is stale', async () => {
    const fetchMock = stubChat('ok', '- none');
    await runFinalizeIntelligence(
      's1',
      settings({
        llmProviderId: 'openai',
        llmApiKey: 'sk-x',
        llmBaseUrl: 'http://evil.example/v1',
      }),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('redacts stored text and speaker when redactAtRest is on', async () => {
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
    expect(segs[0]?.speaker).toContain('[EMAIL]');
    expect(segs[0]?.speaker).not.toContain('ada@example.com');
  });

  it('still records STT cost from audio segments when no LLM is configured', async () => {
    await runFinalizeIntelligence('s1', settings({ providerId: 'openai' }));
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toBeUndefined();
    expect(got?.costUsd).toBe(0.0001); // 1s of OpenAI whisper-1
  });

  it('charges STT only for audio segments (captions and empty → 0)', async () => {
    await deleteSegmentsForSession('s1');
    await putSegments([
      {
        id: 'cap',
        sessionId: 's1',
        startMs: 0,
        endMs: 60_000,
        text: 'caption only',
        source: 'captions',
      },
    ]);
    await runFinalizeIntelligence('s1', settings({ providerId: 'openai' }));
    expect((await getSession('s1'))?.costUsd).toBe(0);
  });

  it('stores costUsd null (n/a) for an unknown STT model', async () => {
    await runFinalizeIntelligence(
      's1',
      settings({ providerId: 'openai', model: 'gpt-4o-transcribe' }),
    );
    expect((await getSession('s1'))?.costUsd).toBeNull();
  });

  it('keeps a known LLM cost when STT is unknown', async () => {
    stubChat('ok', '- none');
    await runFinalizeIntelligence(
      's1',
      settings({
        providerId: 'openrouter',
        llmProviderId: 'openai',
        llmApiKey: 'sk-x',
      }),
    );
    const got = await getSession('s1');
    expect(got?.costUsd).toBeGreaterThan(0);
    expect(got?.costUsd).not.toBeNull();
  });

  it('sums provider-reported STT cost with the LLM estimate', async () => {
    stubChat('ok', '- none');
    await updateSession('s1', { providerCostUsd: 0.00003036 });
    await runFinalizeIntelligence(
      's1',
      settings({
        providerId: 'openrouter',
        llmProviderId: 'openai',
        llmApiKey: 'sk-x',
      }),
    );
    const got = await getSession('s1');
    expect(got?.costUsd).toBeGreaterThan(0.00003036);
  });

  it('keeps STT cost if the LLM call fails and leaves intelligence pending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await runFinalizeIntelligence(
      's1',
      settings({ providerId: 'openai', llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toBeUndefined();
    expect(got?.costUsd).toBe(0.0001);
    expect(got?.intelligence).toBe('pending');
  });

  it('stores structured summary and derived markdown after finalize', async () => {
    const reply = JSON.stringify({
      narrative: 'Shipped decision.',
      actionItems: [{ text: 'Send the notes', owner: 'Bo' }],
      decisions: ['Ship it'],
      usefulInfo: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 }),
      ),
    );
    await runFinalizeIntelligence(
      's1',
      settings({ llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const row = await getSession('s1');
    expect(row?.summary?.actionItems).toHaveLength(1);
    expect(row?.summaryMarkdown).toContain('## Action items');
    expect(row?.summaryMarkdown).toContain('- [ ] Bo — Send the notes');
    expect(row?.intelligence).toBeNull();
  });

  it('stores degraded summary when the model returns prose', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'plain text' } }] }), {
          status: 200,
        }),
      ),
    );
    await runFinalizeIntelligence(
      's1',
      settings({ llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const row = await getSession('s1');
    expect(row?.summary?.degraded).toBe(true);
    expect(row?.summaryMarkdown).toContain('plain text');
  });

  it('does not fetch when the LLM origin is not permitted', async () => {
    stubChrome({ contains: false });
    const fetchMock = stubChat('nope', '- nope');
    await runFinalizeIntelligence(
      's1',
      settings({ llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getSession('s1'))?.intelligence).toBe('needs-permission');
  });
});

describe('live/broadcast redaction path', () => {
  it('redacts speaker as well as text (same helper as offscreen)', () => {
    const stored = redactSegments(
      [
        {
          id: 'x',
          sessionId: 's1',
          startMs: 0,
          endMs: 1,
          text: 'hi ada@example.com',
          speaker: 'Ada 4155552671',
          source: 'audio' as const,
        },
      ],
      { extraTerms: ['Ada'] },
    );
    expect(stored[0]?.text).toBe('hi [EMAIL]');
    expect(stored[0]?.speaker).toBe('[REDACTED] [PHONE]');
  });
});

describe('scheduleFinalizeIntelligence', () => {
  it('marks pending and returns without waiting for the LLM', async () => {
    const resolvers: Array<(v: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    await scheduleFinalizeIntelligence(
      's1',
      settings({ llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const mid = await getSession('s1');
    expect(mid?.intelligence).toBe('pending');
    expect(mid?.summaryMarkdown).toBeUndefined();
    const ok = new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
    });
    for (const resolve of resolvers) resolve(ok);
  });
});

describe('retryPendingIntelligence', () => {
  it('regenerates summaries for pending sessions on boot', async () => {
    stubChat('Recovered.', '- none');
    stubChrome({
      settings: settings({ llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    });
    await updateSession('s1', { intelligence: 'pending' });
    await retryPendingIntelligence();
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toContain('Recovered.');
    expect(got?.intelligence).toBeNull();
  });
});
