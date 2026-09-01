import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../utils/db';
import {
  CHAT_HISTORY_MAX_TURNS,
  answerTranscriptQuestion,
  sanitizeChatHistory,
} from '../utils/intelligence';
import { putSegments } from '../utils/segmentStore';
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

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  llmProviderId: 'openai',
  llmApiKey: 'sk-x',
  ...over,
});

function stubChrome(opts: { contains?: boolean } = {}) {
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn().mockResolvedValue(opts.contains ?? true),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS }),
      },
    },
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function stubAnswer(content: string) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
      text: 'Ada at ada@example.com will ship on Friday.',
      speaker: 'Ada',
      source: 'audio',
    },
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  await deleteDb();
});

describe('sanitizeChatHistory', () => {
  it('returns [] for non-arrays and drops malformed or empty turns', () => {
    expect(sanitizeChatHistory(undefined)).toEqual([]);
    expect(sanitizeChatHistory('nope')).toEqual([]);
    expect(
      sanitizeChatHistory([
        { q: 'ok?', a: 'yes' },
        { q: '', a: 'yes' },
        { q: 'ok?', a: '   ' },
        { q: 42, a: 'yes' },
        null,
        'junk',
      ]),
    ).toEqual([{ q: 'ok?', a: 'yes' }]);
  });

  it('keeps only the most recent turns beyond the cap', () => {
    const many = Array.from({ length: CHAT_HISTORY_MAX_TURNS + 3 }, (_, i) => ({
      q: `q${i}`,
      a: `a${i}`,
    }));
    const kept = sanitizeChatHistory(many);
    expect(kept).toHaveLength(CHAT_HISTORY_MAX_TURNS);
    expect(kept[0]!.q).toBe('q3');
    expect(kept[kept.length - 1]!.q).toBe(`q${CHAT_HISTORY_MAX_TURNS + 2}`);
  });
});

describe('answerTranscriptQuestion', () => {
  it('fails without an LLM configured', async () => {
    const res = await answerTranscriptQuestion('s1', 'What happened?', [], {
      ...DEFAULT_SETTINGS,
    });
    expect(res).toEqual({ ok: false, error: 'No LLM configured' });
  });

  it('reports needs-permission when the LLM origin is not granted', async () => {
    stubChrome({ contains: false });
    const res = await answerTranscriptQuestion('s1', 'What happened?', [], settings());
    expect(res).toEqual({ ok: false, error: 'needs-permission' });
  });

  it('rejects an empty question', async () => {
    const res = await answerTranscriptQuestion('s1', '   ', [], settings());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/i);
  });

  it('fails plainly for a session with no segments', async () => {
    const res = await answerTranscriptQuestion('missing', 'What happened?', [], settings());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no transcript/i);
  });

  it('answers from the redacted transcript with history and adds cost', async () => {
    const fetchMock = stubAnswer('Ship on Friday. [00:00]');
    const res = await answerTranscriptQuestion(
      's1',
      'When do we ship?',
      [{ q: 'Who is here?', a: 'Ada.' }],
      settings(),
    );
    expect(res).toEqual({ ok: true, answer: 'Ship on Friday. [00:00]' });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: { role: string; content: string }[];
    };
    const all = body.messages.map((m) => m.content).join('\n');
    // Redaction ran before the LLM call.
    expect(all).not.toContain('ada@example.com');
    // Data framing + question from the shared builder; history precedes it.
    expect(body.messages[0]!.role).toBe('system');
    expect(all).toContain('<transcript>');
    expect(all).toContain('Question: When do we ship?');
    expect(body.messages.some((m) => m.role === 'user' && m.content === 'Who is here?')).toBe(true);
    expect(body.messages.some((m) => m.role === 'assistant' && m.content === 'Ada.')).toBe(true);

    const row = await getSession('s1');
    expect(row?.costUsd).toBeGreaterThan(0);
  });

  it('humanizes provider failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const res = await answerTranscriptQuestion('s1', 'What happened?', [], settings());
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
