import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSegments } from '@scribetab/shared';
import { closeDb } from '../utils/db';
import {
  createDeltaEmitter,
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
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
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

function ssePayload(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
}

function jsonChat(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function stubChat(summary: string, actions: string) {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      messages: { role: string; content: string }[];
      stream?: boolean;
    };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const content = user.startsWith('Summarize') ? summary : actions;
    if (body.stream) {
      return new Response(ssePayload(content), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return jsonChat(content);
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
    expect(got?.intelligence).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('persists the failure reason when the LLM call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await runFinalizeIntelligence(
      's1',
      settings({ providerId: 'openai', llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const got = await getSession('s1');
    expect(got?.intelligence).toBe('pending');
    expect(typeof got?.intelligenceError).toBe('string');
    expect(got?.intelligenceError?.length).toBeGreaterThan(0);
  });

  it('clears a stored failure reason on later success', async () => {
    await updateSession('s1', { intelligence: 'pending', intelligenceError: 'HTTP 500' });
    stubChat('Ship on Friday.', '- Ada ships');
    await runFinalizeIntelligence(
      's1',
      settings({ providerId: 'openai', llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const got = await getSession('s1');
    expect(got?.intelligence).toBeNull();
    expect(got?.intelligenceError).toBeNull();
  });

  it('accumulates first-call LLM cost if the second call fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(ssePayload('Summary only'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
      .mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await runFinalizeIntelligence(
      's1',
      settings({ providerId: 'openai', llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    );
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toBeUndefined();
    expect(got?.costUsd).toBeGreaterThan(0.0001);
    expect(got?.intelligence).toBe('pending');
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
    expect(typeof mid?.intelligenceStartedAt).toBe('number');
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

  it('clears intelligenceError and refreshes startedAt before retrying', async () => {
    let midError: string | null | undefined;
    let midStartedAt: number | undefined;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (midStartedAt === undefined) {
        const mid = await getSession('s1');
        midError = mid?.intelligenceError;
        midStartedAt = mid?.intelligenceStartedAt;
      }
      return new Response(ssePayload('Recovered.'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    stubChrome({
      settings: settings({ llmProviderId: 'openai', llmApiKey: 'sk-x' }),
    });
    await updateSession('s1', {
      intelligence: 'pending',
      intelligenceError: 'HTTP 500',
      intelligenceStartedAt: 1,
    });
    await retryPendingIntelligence();
    expect(midError).toBeNull();
    expect(midStartedAt).toBeGreaterThan(1);
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toContain('Recovered.');
  });
});

describe('runFinalizeIntelligence streaming', () => {
  const llm = settings({
    providerId: 'openai',
    llmProviderId: 'openai',
    llmApiKey: 'sk-x',
  });

  it('prefers provider.stream when defined', async () => {
    const fetchMock = stubChat('Ship on Friday.', '- Ada ships');
    await runFinalizeIntelligence('s1', llm);
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse(c[1].body as string) as { stream?: boolean },
    );
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.stream === true)).toBe(true);
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toContain('Ship on Friday.');
    expect(got?.intelligence).toBeNull();
    const send = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    const deltas = send.mock.calls
      .map((c) => c[0] as { type?: string; phase?: string; text?: string; runId?: string })
      .filter((m) => m?.type === 'SUMMARY_DELTA');
    expect(deltas.some((d) => d.phase === 'summary' && d.text === 'Ship on Friday.')).toBe(true);
    expect(deltas.some((d) => d.phase === 'actions')).toBe(true);
    expect(new Set(deltas.map((d) => d.runId)).size).toBe(1);
    expect(typeof deltas[0]?.runId).toBe('string');
  });

  it('falls back to complete when stream fails before any delta', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        messages: { role: string; content: string }[];
        stream?: boolean;
      };
      if (body.stream) return new Response('nope', { status: 500 });
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const content = user.startsWith('Summarize') ? 'Ship on Friday.' : '- Ada ships';
      return jsonChat(content);
    });
    vi.stubGlobal('fetch', fetchMock);
    await runFinalizeIntelligence('s1', llm);
    const got = await getSession('s1');
    expect(got?.summaryMarkdown).toContain('Ship on Friday.');
    expect(got?.intelligence).toBeNull();
    expect(got?.intelligenceError).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('still persists intelligenceError when stream and complete both fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await runFinalizeIntelligence('s1', llm);
    const got = await getSession('s1');
    expect(got?.intelligence).toBe('pending');
    expect(typeof got?.intelligenceError).toBe('string');
    expect(got?.intelligenceError?.length).toBeGreaterThan(0);
  });
});

describe('createDeltaEmitter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('trailing flush delivers final accumulated text', () => {
    vi.useFakeTimers();
    const emit = createDeltaEmitter('s1', 'run-1');
    emit('summary', 'Hel');
    emit('summary', 'Hello');
    emit('summary', 'Hello world');
    const send = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    const texts = send.mock.calls
      .map((c) => c[0] as { type?: string; text?: string })
      .filter((m) => m?.type === 'SUMMARY_DELTA')
      .map((m) => m.text);
    expect(texts).toEqual(['Hel']);
    vi.advanceTimersByTime(150);
    const flushed = send.mock.calls
      .map((c) => c[0] as { type?: string; text?: string; runId?: string; phase?: string })
      .filter((m) => m?.type === 'SUMMARY_DELTA');
    expect(flushed.map((m) => m.text)).toEqual(['Hel', 'Hello world']);
    expect(flushed[1]).toMatchObject({
      sessionId: 's1',
      runId: 'run-1',
      phase: 'summary',
      text: 'Hello world',
    });
  });
});
