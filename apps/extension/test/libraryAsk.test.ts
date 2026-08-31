import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChatMessages, type TranscriptSegment } from '@scribetab/shared';
import type { SearchResult } from 'minisearch';
import { closeDb } from '../utils/db';
import {
  answerLibraryQuestion,
  blocksToTranscriptSegments,
  neighborSegments,
  selectContext,
  topMatchedSessions,
  type LibraryAskHit,
} from '../utils/libraryAsk';
import { putSegments } from '../utils/segmentStore';
import { createSession } from '../utils/sessionStore';
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

const T0 = Date.parse('2026-08-27T10:00:00.000Z');

function seg(sessionId: string, id: string, startMs: number, text: string): TranscriptSegment {
  return { id, sessionId, startMs, endMs: startMs + 1000, text, speaker: 'Ada', source: 'audio' };
}

function hit(sessionId: string, title: string, segments: TranscriptSegment[]): LibraryAskHit {
  return { sessionId, title, startedAt: T0, segments };
}

function searchResult(id: string, sessionId: string, score: number): SearchResult {
  return { id, score, sessionId, terms: [id], match: {} } as unknown as SearchResult;
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
    endedAt: '2026-08-27T10:05:00.000Z',
  });
  await createSession({
    id: 's2',
    title: 'Retro',
    startedAt: '2026-08-26T09:00:00.000Z',
    platform: 'meet',
    status: 'complete',
    endedAt: '2026-08-26T09:05:00.000Z',
  });
  await putSegments([
    seg('s1', 'a1', 0, 'Kickoff: sprint goals review.'),
    seg('s1', 'a2', 30_000, 'Ada will ship the search index.'),
    seg('s1', 'a3', 60_000, 'Email ada@example.com for the access.'),
    seg('s1', 'a4', 90_000, 'Deploy happens on Friday.'),
    seg('s1', 'a5', 120_000, 'Ben will review the pull request.'),
    seg('s1', 'a6', 150_000, 'Wrap up and record action items.'),
    seg('s2', 'b1', 0, 'Retro board covered testing and morale.'),
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  await deleteDb();
});

describe('topMatchedSessions', () => {
  it('groups by session and orders by best score, capped at maxSessions', () => {
    const results = [
      searchResult('a2', 's1', 1),
      searchResult('b1', 's2', 2),
      searchResult('a1', 's1', 3),
      searchResult('c1', 's3', 1.5),
    ];
    const groups = topMatchedSessions(results, 8);
    expect(groups.map((g) => g.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(groups[0]!.matchedIds).toEqual(new Set(['a1', 'a2']));
    expect(topMatchedSessions(results, 2).map((g) => g.sessionId)).toEqual(['s1', 's2']);
  });

  it('skips malformed results', () => {
    const results = [searchResult('a1', '', 3), searchResult('a1', 's1', 2)];
    expect(topMatchedSessions(results, 8).map((g) => g.sessionId)).toEqual(['s1']);
  });
});

describe('neighborSegments', () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => seg('s1', id, i * 1000, `text ${id}`));

  it('includes the matched segment plus ±2 neighbors', () => {
    expect(neighborSegments(all, new Set(['c'])).map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('dedupes overlapping windows', () => {
    expect(neighborSegments(all, new Set(['b', 'c'])).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('clamps at the edges of the transcript', () => {
    expect(neighborSegments(all, new Set(['f'])).map((s) => s.id)).toEqual(['d', 'e', 'f']);
    expect(neighborSegments(all, new Set(['a'])).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('ignores unknown ids, honors a custom radius, and sorts by startMs', () => {
    const shuffled = [all[3]!, all[0]!, all[5]!, all[1]!];
    expect(neighborSegments(shuffled, new Set(['a', 'zzz']), 0).map((s) => s.id)).toEqual(['a']);
    expect(neighborSegments(all, new Set(['d']), 1).map((s) => s.id)).toEqual(['c', 'd', 'e']);
  });
});

describe('selectContext', () => {
  it('numbers and orders blocks by search score (input order)', () => {
    const blocks = selectContext(
      [hit('s1', 'Alpha', [seg('s1', 'x', 0, 'hello')]), hit('s2', 'Beta', [seg('s2', 'y', 0, 'hi')])],
      Number.MAX_SAFE_INTEGER,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.header).toMatch(/^## Alpha \(\d{4}-\d{2}-\d{2}\) \[session 1\]$/);
    expect(blocks[1]!.header).toMatch(/^## Beta \(\d{4}-\d{2}-\d{2}\) \[session 2\]$/);
  });

  it('formats bodies as stamped transcript lines', () => {
    const [block] = selectContext([hit('s1', 'Alpha', [seg('s1', 'x', 65_000, 'Hello world')])], 10_000);
    expect(block!.body).toBe('[01:05] Ada: Hello world');
  });

  it('respects the budget, dropping lower-scored meetings whole', () => {
    const mk = (text: string) => [seg('s', 'x', 0, text)];
    const h1 = hit('s1', 'Alpha', mk('a'.repeat(400)));
    const h2 = hit('s2', 'Beta', mk('b'.repeat(400)));
    const full = selectContext([h1, h2], Number.MAX_SAFE_INTEGER);
    expect(full).toHaveLength(2);
    const blockCost = (b: { header: string; body: string }) => b.header.length + 1 + b.body.length;
    // Room for block one plus slack, never for block two.
    const budget = blockCost(full[0]!) + 3;
    const kept = selectContext([h1, h2], budget);
    expect(kept.map((b) => b.header)).toEqual([full[0]!.header]);
    const total = kept.reduce((sum, b) => sum + blockCost(b), 0);
    expect(total).toBeLessThanOrEqual(budget);
  });

  it('trims the top-scored body when nothing fits', () => {
    const h1 = hit('s1', 'Alpha', [seg('s1', 'x', 0, 'a'.repeat(400))]);
    const full = selectContext([h1], Number.MAX_SAFE_INTEGER);
    const budget = full[0]!.header.length + 21;
    const kept = selectContext([h1], budget);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.header).toBe(full[0]!.header);
    expect(kept[0]!.body.length).toBeLessThanOrEqual(20);
    expect(kept[0]!.header.length + 1 + kept[0]!.body.length).toBeLessThanOrEqual(budget);
  });

  it('returns nothing for an empty hit list', () => {
    expect(selectContext([], 1000)).toEqual([]);
  });
});

describe('blocksToTranscriptSegments', () => {
  it('wraps each block as an unstamped pseudo segment aligned to its hit', () => {
    const hits = [hit('s1', 'Alpha', [seg('s1', 'x', 0, 'Hello')])];
    const blocks = selectContext(hits, 10_000);
    const pseudo = blocksToTranscriptSegments(blocks, hits);
    expect(pseudo).toHaveLength(1);
    expect(pseudo[0]!.sessionId).toBe('s1');
    expect(pseudo[0]!.text).toBe(`${blocks[0]!.header}\n${blocks[0]!.body}`);
    // NaN start keeps the shared builder from stamping the block header.
    expect(Number.isNaN(pseudo[0]!.startMs)).toBe(true);
    const transcript = buildChatMessages({ segments: pseudo, question: 'Why?' }).at(-1)!.content;
    expect(transcript).toContain('## Alpha (');
    expect(transcript).not.toMatch(/\[\d{2}:\d{2}\] ##/);
    expect(transcript).toContain('[00:00] Ada: Hello');
  });
});

describe('answerLibraryQuestion', () => {
  it('fails without an LLM configured', async () => {
    const res = await answerLibraryQuestion('What happened?', { ...DEFAULT_SETTINGS });
    expect(res).toEqual({ ok: false, error: 'No LLM configured' });
  });

  it('reports needs-permission when the LLM origin is not granted', async () => {
    stubChrome({ contains: false });
    const res = await answerLibraryQuestion('What happened?', settings());
    expect(res).toEqual({ ok: false, error: 'needs-permission' });
  });

  it('rejects an empty question', async () => {
    const res = await answerLibraryQuestion('   ', settings());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/i);
  });

  it('says when nothing matches', async () => {
    stubAnswer('irrelevant');
    const res = await answerLibraryQuestion('zzzzzzzz', settings());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no matching meetings/i);
  });

  it('answers from the top-matched meeting with neighbors, redaction, and sources', async () => {
    const fetchMock = stubAnswer('Deploy is on Friday. [Standup 01:30]');
    const res = await answerLibraryQuestion('deploy', settings());
    expect(res.ok).toBe(true);
    expect(res.answer).toBe('Deploy is on Friday. [Standup 01:30]');
    expect(res.sources).toEqual([{ sessionId: 's1', title: 'Standup' }]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: { role: string; content: string }[];
    };
    const all = body.messages.map((m) => m.content).join('\n');
    // Block header format from the brief; citation instruction adjusted.
    expect(all).toMatch(/## Standup \(\d{4}-\d{2}-\d{2}\) \[session 1\]/);
    expect(all).toContain('cite moments as [meeting title mm:ss]');
    expect(all).toContain('<transcript>');
    expect(all).toContain('Question: deploy');
    // Neighbor expansion around the match: a2 (00:30) and a6 (02:30) ride along…
    expect(all).toContain('[00:30] Ada: Ada will ship the search index.');
    expect(all).toContain('[02:30] Ada: Wrap up and record action items.');
    // …but the segment two-plus lines before the first match does not.
    expect(all).not.toContain('Kickoff: sprint goals review.');
    // Redaction ran before the LLM saw the text.
    expect(all).not.toContain('ada@example.com');
  });
});
