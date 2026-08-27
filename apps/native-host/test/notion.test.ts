import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import {
  MAX_429_RETRIES,
  NOTION_API,
  NOTION_BATCH_MAX_BYTES,
  NOTION_CHILDREN_MAX,
  NOTION_RICH_TEXT_MAX,
  batchBlocks,
  buildNotionBlocks,
  chunkRichText,
  createNotionPage,
  loadNotionPageMap,
} from '../src/notion.js';
import { withHome } from './helpers.js';

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

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, '.local', 'share') };
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

  it('does not split a surrogate pair at the 2000-unit boundary', () => {
    const emoji = '😀';
    const text = 'a'.repeat(NOTION_RICH_TEXT_MAX - 1) + emoji + 'z';
    const parts = chunkRichText(text);
    expect(parts[0]!.text.content.endsWith('a')).toBe(true);
    expect(parts[1]!.text.content.startsWith(emoji)).toBe(true);
    expect(parts.map((p) => p.text.content).join('')).toBe(text);
    expect(parts[0]!.text.content).toHaveLength(NOTION_RICH_TEXT_MAX - 1);
  });

  it('batches children into groups of 100', () => {
    const batches = batchBlocks(Array.from({ length: 101 }, (_, i) => i));
    expect(batches[0]).toHaveLength(NOTION_CHILDREN_MAX);
    expect(batches[1]).toHaveLength(1);
  });

  it('splits an oversize multilingual batch before 400KB', () => {
    const cjk = '字'.repeat(1500);
    const items = Array.from({ length: 100 }, () => ({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: cjk } }] },
    }));
    const batches = batchBlocks(items);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]!.length).toBeLessThan(NOTION_CHILDREN_MAX);
    for (const batch of batches) {
      const bytes = Buffer.byteLength(JSON.stringify(batch), 'utf8');
      if (batch.length > 1) expect(bytes).toBeLessThanOrEqual(NOTION_BATCH_MAX_BYTES);
    }
  });
});

describe('createNotionPage', () => {
  it('creates then appends leftover blocks, only to api.notion.com', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
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
      const result = await createNotionPage({
        token: 'ntn_secret',
        parentPageId: 'parent-1',
        session,
        segments: segs(120),
        fetchImpl,
        env,
        platform: 'linux',
      });
      expect(result).toEqual({ pageId: 'page-1', skipped: false });
      expect(calls[0]?.url).toBe(`${NOTION_API}/pages`);
      expect(calls[1]?.url).toBe(`${NOTION_API}/blocks/page-1/children`);
      expect(calls[1]?.method).toBe('PATCH');
      expect(JSON.stringify(calls)).not.toContain('should-not-leak-host');
    });
  });

  it('skips page creation on a second sync of the same sessionId', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      let creates = 0;
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/pages')) {
          creates += 1;
          return new Response(JSON.stringify({ id: 'page-1' }), { status: 200 });
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };
      const first = await createNotionPage({
        token: 'ntn_secret',
        parentPageId: 'parent-1',
        session,
        segments: [],
        fetchImpl,
        env,
        platform: 'linux',
      });
      const second = await createNotionPage({
        token: 'ntn_secret',
        parentPageId: 'parent-1',
        session,
        segments: [],
        fetchImpl,
        env,
        platform: 'linux',
      });
      expect(first.pageId).toBe('page-1');
      expect(second).toEqual({ pageId: 'page-1', skipped: true });
      expect(creates).toBe(1);
      const map = await loadNotionPageMap(env, 'linux');
      expect(map[session.id]?.status).toBe('ok');
    });
  });

  it('archives a partial page and recreates on the next sync', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const calls: string[] = [];
      let creates = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = String(init?.method);
        calls.push(`${method} ${url}`);
        if (url.endsWith('/pages') && method === 'POST') {
          creates += 1;
          return new Response(JSON.stringify({ id: `page-${creates}` }), { status: 200 });
        }
        if (url.includes('/blocks/') && url.endsWith('/children')) {
          return new Response('append failed', { status: 500 });
        }
        if (method === 'PATCH' && url.includes('/pages/')) {
          return new Response('{}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      };
      await expect(
        createNotionPage({
          token: 'ntn_secret',
          parentPageId: 'parent-1',
          session,
          segments: segs(120),
          fetchImpl,
          env,
          platform: 'linux',
        }),
      ).rejects.toThrow(/500/);
      const map = await loadNotionPageMap(env, 'linux');
      expect(map[session.id]?.status).toBe('partial');
      expect(map[session.id]?.pageId).toBe('page-1');

      await expect(
        createNotionPage({
          token: 'ntn_secret',
          parentPageId: 'parent-1',
          session,
          segments: segs(120),
          fetchImpl,
          env,
          platform: 'linux',
        }),
      ).rejects.toThrow(/500/);
      expect(creates).toBe(2);
      expect(calls.some((c) => c.startsWith('PATCH ') && c.includes('/pages/page-1'))).toBe(true);
      const map2 = await loadNotionPageMap(env, 'linux');
      expect(map2[session.id]?.pageId).toBe('page-2');
      expect(map2[session.id]?.status).toBe('partial');
    });
  });

  it('maps 401 and 404 without retry', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await expect(
        createNotionPage({
          token: 'bad',
          parentPageId: 'p',
          session,
          segments: [],
          fetchImpl: async () => new Response('nope', { status: 401 }),
          env,
          platform: 'linux',
        }),
      ).rejects.toThrow(/401/);
      await expect(
        createNotionPage({
          token: 't',
          parentPageId: 'missing',
          session,
          segments: [],
          fetchImpl: async () => new Response('gone', { status: 404 }),
          env,
          platform: 'linux',
        }),
      ).rejects.toThrow(/404/);
    });
  });

  it('retries 429 using Retry-After then succeeds', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      let n = 0;
      const result = await createNotionPage({
        token: 't',
        parentPageId: 'p',
        session,
        segments: [],
        env,
        platform: 'linux',
        fetchImpl: async () => {
          n += 1;
          if (n === 1) return new Response('slow', { status: 429, headers: { 'Retry-After': '0' } });
          return new Response(JSON.stringify({ id: 'page-r' }), { status: 200 });
        },
      });
      expect(result.pageId).toBe('page-r');
      expect(n).toBe(2);
    });
  });

  it('exhausts 429 retries then throws', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      let n = 0;
      await expect(
        createNotionPage({
          token: 't',
          parentPageId: 'p',
          session,
          segments: [],
          env,
          platform: 'linux',
          fetchImpl: async () => {
            n += 1;
            return new Response('slow', { status: 429, headers: { 'Retry-After': '0' } });
          },
        }),
      ).rejects.toThrow(/429/);
      expect(n).toBe(MAX_429_RETRIES + 1);
    });
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
