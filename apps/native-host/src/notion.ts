import { readFile } from 'node:fs/promises';
import { actionItemLine, type ActionItem, type MeetingSession, type TranscriptSegment } from '@scribetab/shared';
import { atomicWriteFile } from './atomicWrite.js';
import { notionActionsPath, notionPagesPath } from './paths.js';

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
export const NOTION_RICH_TEXT_MAX = 2000;
export const NOTION_CHILDREN_MAX = 100;
export const NOTION_BATCH_MAX_BYTES = 400 * 1024;
export const MAX_429_RETRIES = 3;
export const MAX_RETRY_AFTER_MS = 30_000;
export const NOTION_FETCH_TIMEOUT_MS = 15_000;
export const NOTION_INTEGRATION_BUDGET_MS = 60_000;

export type NotionRichText = {
  type: 'text';
  text: { content: string };
};

export type NotionBlock =
  | {
      object: 'block';
      type: 'heading_1';
      heading_1: { rich_text: NotionRichText[] };
    }
  | {
      object: 'block';
      type: 'heading_2';
      heading_2: { rich_text: NotionRichText[] };
    }
  | {
      object: 'block';
      type: 'paragraph';
      paragraph: { rich_text: NotionRichText[] };
    }
  | {
      object: 'block';
      type: 'to_do';
      to_do: { rich_text: NotionRichText[]; checked: boolean };
    };

export type NotionPageRecord = {
  pageId: string;
  status: 'ok' | 'partial';
  error?: string;
};

export type NotionPageMap = Record<string, NotionPageRecord>;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeEnd(text: string, start: number, proposed: number): number {
  let end = proposed;
  if (
    end > start &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return end > start ? end : proposed;
}

export function chunkRichText(text: string, max = NOTION_RICH_TEXT_MAX): NotionRichText[] {
  if (!text) return [];
  const parts: NotionRichText[] = [];
  let i = 0;
  while (i < text.length) {
    const end = safeEnd(text, i, Math.min(i + max, text.length));
    parts.push({ type: 'text', text: { content: text.slice(i, end) } });
    i = end;
  }
  return parts;
}

function heading1(text: string): NotionBlock {
  const content = chunkRichText(text.slice(0, NOTION_RICH_TEXT_MAX + 2), NOTION_RICH_TEXT_MAX)[0]?.text.content
    || 'Untitled';
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

function heading2(text: string): NotionBlock {
  const content = chunkRichText(text.slice(0, NOTION_RICH_TEXT_MAX + 2), NOTION_RICH_TEXT_MAX)[0]?.text.content ?? '';
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

function paragraphBlocks(text: string): NotionBlock[] {
  if (!text) return [];
  const chunks = chunkRichText(text);
  return chunks.map((rt) => ({
    object: 'block' as const,
    type: 'paragraph' as const,
    paragraph: { rich_text: [rt] },
  }));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function buildNotionBlocks(
  session: MeetingSession,
  segments: TranscriptSegment[],
  summaryMarkdown?: string,
): NotionBlock[] {
  const blocks: NotionBlock[] = [heading1(session.title)];
  const meta = [
    `Session ID: ${session.id}`,
    `Started: ${session.startedAt}`,
    `Ended: ${session.endedAt ?? 'in progress'}`,
    `Platform: ${session.platform}`,
    session.tabUrl ? `URL: ${session.tabUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  blocks.push(...paragraphBlocks(meta));

  const summary = summaryMarkdown?.trim();
  if (summary) {
    blocks.push(heading2('Summary'));
    for (const p of splitParagraphs(summary)) blocks.push(...paragraphBlocks(p));
  }

  blocks.push(heading2('Transcript'));
  const segs = segments.slice().sort((a, b) => a.startMs - b.startMs);
  if (segs.length === 0) {
    blocks.push(...paragraphBlocks('(empty transcript)'));
  } else {
    for (const seg of segs) {
      const line = seg.speaker ? `${seg.speaker}: ${seg.text}` : seg.text;
      blocks.push(...paragraphBlocks(line));
    }
  }
  return blocks;
}

export function batchBlocks<T>(
  items: T[],
  size = NOTION_CHILDREN_MAX,
  maxBytes = NOTION_BATCH_MAX_BYTES,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const item of items) {
    if (cur.length >= size) {
      out.push(cur);
      cur = [];
    } else if (cur.length > 0) {
      const nextBytes = Buffer.byteLength(JSON.stringify([...cur, item]), 'utf8');
      if (nextBytes > maxBytes) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(item);
  }
  if (cur.length) out.push(cur);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (!raw) return 1000;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) {
    return Math.min(sec * 1000, MAX_RETRY_AFTER_MS);
  }
  return 1000;
}

function notionError(status: number, body: string): Error {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 180);
  if (status === 401) return new Error('Notion auth failed (401). Check notion.token.');
  if (status === 404) return new Error('Notion parent page not found (404). Check notion.parentPageId.');
  if (status === 429) return new Error(`Notion rate limited (429). ${snippet}`.trim());
  return new Error(`Notion API ${status}${snippet ? `: ${snippet}` : ''}`);
}

export async function loadNotionPageMap(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<NotionPageMap> {
  const path = notionPagesPath(platform, env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as NotionPageMap;
  } catch {
    return {};
  }
}

export async function saveNotionPageMap(
  map: NotionPageMap,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const path = notionPagesPath(platform, env);
  await atomicWriteFile(path, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
}

export type NotionActionRecord = {
  pageId: string;
  headingAdded: boolean;
  items: Record<string, { ok: true; at: string }>; // keyed by ActionItem.id
};
export type NotionActionMap = Record<string, NotionActionRecord>; // keyed by sessionId

export async function loadNotionActionMap(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<NotionActionMap> {
  const path = notionActionsPath(platform, env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as NotionActionMap;
  } catch {
    return {};
  }
}

export async function saveNotionActionMap(
  map: NotionActionMap,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const path = notionActionsPath(platform, env);
  await atomicWriteFile(path, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
}

export function actionItemBlocks(items: ActionItem[]): NotionBlock[] {
  return items.map((item) => ({
    object: 'block' as const,
    type: 'to_do' as const,
    to_do: { rich_text: chunkRichText(actionItemLine(item)), checked: false },
  }));
}

export async function appendActionItems(opts: {
  token: string;
  pageId: string;
  sessionId: string;
  items: ActionItem[];
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deadline?: number;
  now?: () => string;
}): Promise<{ results: { id: string; ok: boolean; error?: string }[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const deadline = opts.deadline ?? Date.now() + NOTION_INTEGRATION_BUDGET_MS;
  const now = opts.now ?? (() => new Date().toISOString());
  const map = await loadNotionActionMap(env, platform);
  const existing = map[opts.sessionId];
  const rec: NotionActionRecord =
    existing && existing.pageId === opts.pageId
      ? existing
      : { pageId: opts.pageId, headingAdded: false, items: {} };

  const results: { id: string; ok: boolean; error?: string }[] = [];
  const pending = opts.items.filter((i) => {
    if (rec.items[i.id]?.ok) {
      results.push({ id: i.id, ok: true });
      return false;
    }
    return true;
  });
  if (pending.length === 0) return { results };

  const blocks: NotionBlock[] = [];
  const blockOwners: (string | null)[] = []; // parallel: item id per block, null for heading
  if (!rec.headingAdded) {
    blocks.push(heading2('Action items'));
    blockOwners.push(null);
  }
  for (const item of pending) {
    blocks.push(...actionItemBlocks([item]));
    blockOwners.push(item.id);
  }

  const batches = batchBlocks(blocks.map((b, i) => ({ b, i })));
  let failed: string | undefined;
  for (const batch of batches) {
    if (failed === undefined) {
      try {
        const res = await notionFetch(
          `/blocks/${opts.pageId}/children`,
          opts.token,
          { method: 'PATCH', body: JSON.stringify({ children: batch.map((x) => x.b) }) },
          fetchImpl,
          deadline,
        );
        if (!res.ok) throw notionError(res.status, await res.text().catch(() => ''));
        for (const x of batch) {
          const id = blockOwners[x.i];
          if (id === undefined) continue;
          if (id === null) rec.headingAdded = true;
          else {
            rec.items[id] = { ok: true, at: now() };
            results.push({ id, ok: true });
          }
        }
        map[opts.sessionId] = rec;
        await saveNotionActionMap(map, env, platform);
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
    }
    if (failed !== undefined) {
      for (const x of batch) {
        const id = blockOwners[x.i];
        if (id != null && !rec.items[id]?.ok) results.push({ id, ok: false, error: failed });
      }
    }
  }
  return { results };
}

async function notionFetch(
  path: string,
  token: string,
  init: { method: string; body?: string },
  fetchImpl: typeof fetch,
  deadline: number,
): Promise<Response> {
  if (!path.startsWith('/')) throw new Error('Notion path must be absolute on api.notion.com');
  const url = `${NOTION_API}${path}`;
  if (!url.startsWith('https://api.notion.com/')) {
    throw new Error('Refusing to send Notion token off api.notion.com');
  }
  let last429: Response | undefined;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Notion integration timed out');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(NOTION_FETCH_TIMEOUT_MS, remaining));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: init.body,
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new Error('Notion request timed out');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 429) return res;
    last429 = res;
    if (attempt === MAX_429_RETRIES) break;
    const wait = retryAfterMs(res);
    if (Date.now() + wait >= deadline) throw new Error('Notion integration timed out');
    await sleep(wait);
  }
  const body = last429 ? await last429.text().catch(() => '') : '';
  throw notionError(429, body);
}

async function archiveNotionPage(
  pageId: string,
  token: string,
  fetchImpl: typeof fetch,
  deadline: number,
): Promise<void> {
  const res = await notionFetch(
    `/pages/${pageId}`,
    token,
    { method: 'PATCH', body: JSON.stringify({ archived: true }) },
    fetchImpl,
    deadline,
  );
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => '');
    throw notionError(res.status, t);
  }
}

export async function createNotionPage(opts: {
  token: string;
  parentPageId: string;
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deadline?: number;
}): Promise<{ pageId: string; skipped: boolean }> {
  const token = opts.token.trim();
  const parentPageId = opts.parentPageId.trim();
  if (!token) throw new Error('Notion enabled but notion.token is not set');
  if (!parentPageId) throw new Error('Notion enabled but notion.parentPageId is not set');

  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const deadline = opts.deadline ?? Date.now() + NOTION_INTEGRATION_BUDGET_MS;
  const sessionId = opts.session.id;

  const map = await loadNotionPageMap(env, platform);
  const existing = map[sessionId];
  if (existing?.status === 'ok' && existing.pageId) {
    return { pageId: existing.pageId, skipped: true };
  }
  if (existing?.status === 'partial' && existing.pageId) {
    await archiveNotionPage(existing.pageId, token, fetchImpl, deadline);
    delete map[sessionId];
    await saveNotionPageMap(map, env, platform);
  }

  const blocks = buildNotionBlocks(opts.session, opts.segments, opts.summaryMarkdown);
  const batches = batchBlocks(blocks);
  const first = batches[0] ?? [];

  const createRes = await notionFetch(
    '/pages',
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        parent: { page_id: parentPageId },
        properties: {
          title: {
            title: [{ type: 'text', text: { content: opts.session.title.slice(0, NOTION_RICH_TEXT_MAX) || 'Untitled' } }],
          },
        },
        children: first,
      }),
    },
    fetchImpl,
    deadline,
  );
  const createText = await createRes.text();
  if (!createRes.ok) throw notionError(createRes.status, createText);
  let pageId: string | undefined;
  try {
    pageId = (JSON.parse(createText) as { id?: string }).id;
  } catch {
    throw new Error('Notion pages.create returned invalid JSON');
  }
  if (!pageId) throw new Error('Notion pages.create missing page id');

  map[sessionId] = { pageId, status: 'partial' };
  await saveNotionPageMap(map, env, platform);

  try {
    for (const batch of batches.slice(1)) {
      const appendRes = await notionFetch(
        `/blocks/${pageId}/children`,
        token,
        { method: 'PATCH', body: JSON.stringify({ children: batch }) },
        fetchImpl,
        deadline,
      );
      if (!appendRes.ok) {
        const t = await appendRes.text().catch(() => '');
        throw notionError(appendRes.status, t);
      }
    }
  } catch (e) {
    map[sessionId] = {
      pageId,
      status: 'partial',
      error: e instanceof Error ? e.message : String(e),
    };
    await saveNotionPageMap(map, env, platform);
    throw e;
  }

  map[sessionId] = { pageId, status: 'ok' };
  await saveNotionPageMap(map, env, platform);
  return { pageId, skipped: false };
}
