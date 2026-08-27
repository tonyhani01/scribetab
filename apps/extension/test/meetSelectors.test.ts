import { describe, expect, it } from 'vitest';
import {
  CAPTION_CONTAINER_SELECTORS,
  findCaptionsContainer,
  parseCaptionNodes,
  queryFirst,
  readCaptionItem,
} from '../utils/meetSelectors';

function fakeNode(hits: Record<string, { textContent?: string } | null>): ParentNode & Element {
  return {
    querySelector(sel: string) {
      return (hits[sel] as Element | null | undefined) ?? null;
    },
    querySelectorAll() {
      return [] as unknown as NodeListOf<Element>;
    },
    textContent: Object.values(hits)
      .map((h) => h?.textContent ?? '')
      .join(' '),
    children: [] as unknown as HTMLCollection,
  } as unknown as ParentNode & Element;
}

describe('queryFirst', () => {
  it('returns the first selector that matches, in chain order', () => {
    const root = fakeNode({
      '[data-caption-window]': null,
      'div[aria-label="Captions"]': { textContent: 'hit' },
    });
    const el = queryFirst(root, CAPTION_CONTAINER_SELECTORS);
    expect(el?.textContent).toBe('hit');
  });
});

describe('findCaptionsContainer', () => {
  it('reports not_found when no fallback matches', () => {
    const root = fakeNode({});
    expect(findCaptionsContainer(root)).toEqual({ status: 'not_found' });
  });

  it('reports found with the matching element', () => {
    const node = { textContent: 'captions' };
    const root = fakeNode({ 'div[jsname="dsyh5c"]': node });
    const r = findCaptionsContainer(root);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.element).toBe(node);
  });
});

describe('readCaptionItem', () => {
  it('reads speaker + text via the first matching fallbacks', () => {
    const item = fakeNode({
      '[data-speaker-name]': { textContent: '  Ada  ' },
      '[data-message-text]': { textContent: ' Hello team ' },
    });
    expect(readCaptionItem(item)).toEqual({ speaker: 'Ada', text: 'Hello team' });
  });

  it('falls back to item textContent minus speaker when text selector misses', () => {
    const item = {
      querySelector(sel: string) {
        if (sel === '[data-speaker-name]') return { textContent: 'Ada' };
        return null;
      },
      textContent: 'Ada Hello team',
    } as unknown as Element;
    expect(readCaptionItem(item)).toEqual({ speaker: 'Ada', text: 'Hello team' });
  });

  it('returns null when there is no caption text', () => {
    const item = fakeNode({ '[data-speaker-name]': { textContent: 'Ada' } });
    (item as { textContent: string }).textContent = 'Ada';
    expect(readCaptionItem(item)).toBeNull();
  });
});

describe('parseCaptionNodes', () => {
  it('does not attribute a container-level blob to a matched speaker', () => {
    const container = {
      querySelector(sel: string) {
        if (sel === '[data-speaker-name]') return { textContent: 'Ada' };
        return null;
      },
      querySelectorAll() {
        return [] as unknown as NodeListOf<Element>;
      },
      textContent: 'Ada Hello and also Bob later',
      children: [] as unknown as HTMLCollection,
    } as unknown as Element;
    expect(parseCaptionNodes(container)).toEqual([
      { speaker: '', text: 'Ada Hello and also Bob later' },
    ]);
  });
});
