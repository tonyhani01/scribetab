import { describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import {
  NOTION_API,
  NOTION_CHILDREN_MAX,
  NOTION_RICH_TEXT_MAX,
  batchBlocks,
  buildNotionBlocks,
  chunkRichText,
  createNotionPage,
} from '../src/notion.js';

const session: MeetingSession = {
  id: 'sess-n',
  title: 'Notion Meeting',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'zoom',
  status: 'complete',
};

function segs(n: number): TranscriptSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    sessionId: session.id,
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    text: `line ${i}`,
    source: 'audio' as const,
  }));
}

describe('Notion block builder', () => {
  it('chunks rich_text at 2000 chars and orders segments', () => {
    expect(chunkRichText('a'.repeat(NOTION_RICH_TEXT_MAX + 1))).toHaveLength(2);
    const blocks = buildNotionBlocks(session, [segs(2)[1]!, segs(2)[0]!], '## Recap\n\nHello');
    expect(blocks[0]).toMatchObject({ type: 'heading_1' });
    const types = blocks.map((b) => b.type);
    expect(types).toContain('heading_2');
    const texts = blocks
      .filter((b) => b.type === 'paragraph')
      .map((b) => b.paragraph.rich_text.map((r) => r.text.content).join(''));
    expect(texts.some((t) => t.includes('Hello'))).toBe(true);
    const transcript = texts.filter((t) => t.startsWith('line '));
    expect(transcript).toEqual(['line 0', 'line 1']);
  });

  it('batches children into groups of 100', () => {
    const batches = batchBlocks(Array.from({ length: 101 }, (_, i) => i));
    expect(batches[0]).toHaveLength(NOTION_CHILDREN_MAX);
    expect(batches[1]).toHaveLength(1);
  });
});

describe('createNotionPage', () => {
  it('creates then appends leftover blocks, only to api.notion.com', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? '');
      calls.push({ url, method: String(init?.method), body });
      expect(url.startsWith(NOTION_API)).toBe(true);
      expect(body).not.toContain('should-not-leak-host');
      if (url.endsWith('/pages')) {
        const parsed = JSON.parse(body) as { children: unknown[] };
        expect(parsed.children.length).toBe(NOTION_CHILDREN_MAX);
        return new Response(JSON.stringify({ id: 'page-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const id = await createNotionPage({
      token: 'ntn_secret',
      parentPageId: 'parent-1',
      session,
      segments: segs(120),
      fetchImpl,
    });
    expect(id).toBe('page-1');
    expect(calls[0]?.url).toBe(`${NOTION_API}/pages`);
    expect(calls[1]?.url).toBe(`${NOTION_API}/blocks/page-1/children`);
    expect(calls[1]?.method).toBe('PATCH');
    expect(JSON.stringify(calls)).not.toContain('should-not-leak-host');
  });

  it('maps 401 and 404 without retry', async () => {
    await expect(
      createNotionPage({
        token: 'bad',
        parentPageId: 'p',
        session,
        segments: [],
        fetchImpl: async () => new Response('nope', { status: 401 }),
      }),
    ).rejects.toThrow(/401/);
    await expect(
      createNotionPage({
        token: 't',
        parentPageId: 'missing',
        session,
        segments: [],
        fetchImpl: async () => new Response('gone', { status: 404 }),
      }),
    ).rejects.toThrow(/404/);
  });

  it('retries 429 using Retry-After then succeeds', async () => {
    let n = 0;
    const id = await createNotionPage({
      token: 't',
      parentPageId: 'p',
      session,
      segments: [],
      fetchImpl: async () => {
        n += 1;
        if (n === 1) return new Response('slow', { status: 429, headers: { 'Retry-After': '0' } });
        return new Response(JSON.stringify({ id: 'page-r' }), { status: 200 });
      },
    });
    expect(id).toBe('page-r');
    expect(n).toBe(2);
  });

  it('requires token and parent page id', async () => {
    await expect(
      createNotionPage({ token: '', parentPageId: 'p', session, segments: [] }),
    ).rejects.toThrow(/notion.token/);
    await expect(
      createNotionPage({ token: 't', parentPageId: '  ', session, segments: [] }),
    ).rejects.toThrow(/parentPageId/);
  });
});
