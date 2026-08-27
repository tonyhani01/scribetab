import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
export const NOTION_RICH_TEXT_MAX = 2000;
export const NOTION_CHILDREN_MAX = 100;
const MAX_429_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

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
    };

export function chunkRichText(text: string, max = NOTION_RICH_TEXT_MAX): NotionRichText[] {
  if (!text) return [];
  const parts: NotionRichText[] = [];
  for (let i = 0; i < text.length; i += max) {
    parts.push({ type: 'text', text: { content: text.slice(i, i + max) } });
  }
  return parts;
}

function heading1(text: string): NotionBlock {
  const content = text.slice(0, NOTION_RICH_TEXT_MAX) || 'Untitled';
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

function heading2(text: string): NotionBlock {
  const content = text.slice(0, NOTION_RICH_TEXT_MAX);
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

export function batchBlocks<T>(items: T[], size = NOTION_CHILDREN_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
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

async function notionFetch(
  path: string,
  token: string,
  init: { method: string; body?: string },
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!path.startsWith('/')) throw new Error('Notion path must be absolute on api.notion.com');
  const url = `${NOTION_API}${path}`;
  if (!url.startsWith('https://api.notion.com/')) {
    throw new Error('Refusing to send Notion token off api.notion.com');
  }
  let last429: Response | undefined;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetchImpl(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: init.body,
    });
    if (res.status !== 429) return res;
    last429 = res;
    if (attempt === MAX_429_RETRIES) break;
    await sleep(retryAfterMs(res));
  }
  const body = last429 ? await last429.text().catch(() => '') : '';
  throw notionError(429, body);
}

export async function createNotionPage(opts: {
  token: string;
  parentPageId: string;
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const token = opts.token.trim();
  const parentPageId = opts.parentPageId.trim();
  if (!token) throw new Error('Notion enabled but notion.token is not set');
  if (!parentPageId) throw new Error('Notion enabled but notion.parentPageId is not set');

  const fetchImpl = opts.fetchImpl ?? fetch;
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

  for (const batch of batches.slice(1)) {
    const appendRes = await notionFetch(
      `/blocks/${pageId}/children`,
      token,
      { method: 'PATCH', body: JSON.stringify({ children: batch }) },
      fetchImpl,
    );
    if (!appendRes.ok) {
      const t = await appendRes.text().catch(() => '');
      throw notionError(appendRes.status, t);
    }
  }
  return pageId;
}
