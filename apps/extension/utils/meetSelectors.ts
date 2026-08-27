import type { CaptionSnapshot } from './captionReduce';

/**
 * Ordered fallbacks for Google Meet's captions DOM.
 * Meet restyles often; never hard-code these at call sites — always go through
 * `findCaptionsContainer` / `parseCaptionNodes`.
 */
export const CAPTION_CONTAINER_SELECTORS = [
  '[data-caption-window]',
  'div[aria-label="Captions"]',
  'div[aria-label="Live captions"]',
  'div[aria-label="Captions displayed"]',
  'div[jsname="dsyh5c"]',
  'div[jsname="tgaKEf"]',
  '.a4cQT',
] as const;

export const CAPTION_ITEM_SELECTORS = [
  '[data-caption-item]',
  'div[jsname="botPn"]',
] as const;

export const SPEAKER_SELECTORS = [
  '[data-speaker-name]',
  '.NWpY1d',
  '.zs7s8d',
  'span.KcIKyf',
] as const;

export const TEXT_SELECTORS = [
  '[data-message-text]',
  '.ygicle',
  '.iTTPOb',
  '.bh44bd',
] as const;

export type CaptionsContainerState =
  | { status: 'found'; element: Element }
  | { status: 'not_found' };

export function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function findCaptionsContainer(root: ParentNode): CaptionsContainerState {
  const element = queryFirst(root, CAPTION_CONTAINER_SELECTORS);
  return element ? { status: 'found', element } : { status: 'not_found' };
}

export function readCaptionItem(item: Element): CaptionSnapshot | null {
  const speakerEl = queryFirst(item, SPEAKER_SELECTORS);
  const textEl = queryFirst(item, TEXT_SELECTORS);
  const speaker = (speakerEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  let text = (textEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    const raw = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
    text = speaker && raw.startsWith(speaker) ? raw.slice(speaker.length).trim() : raw;
  }
  if (!text) return null;
  return { speaker, text };
}

function collectItems(container: Element): Element[] {
  for (const sel of CAPTION_ITEM_SELECTORS) {
    const list = [...container.querySelectorAll(sel)];
    if (list.length > 0) return list;
  }
  return [...container.children].filter((el) => (el.textContent ?? '').trim().length > 0);
}

export function parseCaptionNodes(container: Element): CaptionSnapshot[] {
  const items = collectItems(container);
  const snaps: CaptionSnapshot[] = [];
  for (const item of items) {
    const snap = readCaptionItem(item);
    if (snap) snaps.push(snap);
  }
  if (snaps.length === 0) {
    // Item selectors missed. Do not attribute the merged container blob to a
    // speaker that happens to match inside it.
    const text = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) snaps.push({ speaker: '', text });
  }
  return snaps;
}
