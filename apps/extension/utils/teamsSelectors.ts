import type { CaptionSnapshot } from './captionReduce';

/**
 * Fragile Teams web-client DOM selectors. Teams may change these without notice;
 * keep every caption selector in this module so failures remain isolated.
 */
export const TEAMS_CAPTIONS_CONTAINER_SELECTOR =
  '[data-tid="closed-caption-renderer"], [data-tid="closed-captions-renderer"]';
export const TEAMS_CAPTION_ROW_SELECTOR = '[data-tid="closed-caption-message"]';
export const TEAMS_AUTHOR_SELECTOR = '[data-tid="author"]';

export interface TeamsCaptionRow {
  author: string | null | undefined;
  text: string;
}

export type TeamsCaptionsContainerState =
  | { status: 'found'; element: Element }
  | { status: 'not_found' };

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripAuthorPrefix(text: string, author: string): string {
  if (!author || !text.startsWith(author)) return text;
  return text.slice(author.length).replace(/^[\s:：\-–—]+/, '').trim();
}

export function reduceTeamsCaptionRows(rows: readonly TeamsCaptionRow[]): CaptionSnapshot[] {
  const snapshots: CaptionSnapshot[] = [];
  for (const row of rows) {
    const providedAuthor = normalizeText(row.author ?? '');
    const text = stripAuthorPrefix(normalizeText(row.text), providedAuthor);
    if (!text) continue;
    snapshots.push({ speaker: providedAuthor || 'Speaker', text });
  }
  return snapshots;
}

export function findTeamsCaptionsContainer(root: ParentNode): TeamsCaptionsContainerState {
  const element = root.querySelector(TEAMS_CAPTIONS_CONTAINER_SELECTOR);
  return element ? { status: 'found', element } : { status: 'not_found' };
}

export function parseTeamsCaptionNodes(container: Element): CaptionSnapshot[] {
  const rows = [...container.querySelectorAll(TEAMS_CAPTION_ROW_SELECTOR)];
  return reduceTeamsCaptionRows(
    rows.map((row) => ({
      author: row.querySelector(TEAMS_AUTHOR_SELECTOR)?.textContent,
      text: row.textContent ?? '',
    })),
  );
}
