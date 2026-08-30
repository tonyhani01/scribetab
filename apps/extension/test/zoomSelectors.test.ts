import { describe, expect, it } from 'vitest';
import {
  ZOOM_CAPTION_ROW_SELECTOR,
  ZOOM_CAPTIONS_CONTAINER_SELECTOR,
  findZoomCaptionsContainer,
  reduceZoomCaptionRows,
} from '../utils/zoomSelectors';

describe('reduceZoomCaptionRows', () => {
  it('normalizes Zoom rows and removes the speaker label from caption text', () => {
    expect(
      reduceZoomCaptionRows([
        { speaker: '  Ada  ', text: ' Ada   Hello   team ' },
        { speaker: 'Bob', text: 'Bob: Good morning' },
      ]),
    ).toEqual([
      { speaker: 'Ada', text: 'Hello team' },
      { speaker: 'Bob', text: 'Good morning' },
    ]);
  });

  it('uses Speaker when Zoom omits the speaker element', () => {
    expect(reduceZoomCaptionRows([{ speaker: null, text: ' Welcome everyone ' }])).toEqual([
      { speaker: 'Speaker', text: 'Welcome everyone' },
    ]);
  });

  it('drops empty and speaker-only rows', () => {
    expect(
      reduceZoomCaptionRows([
        { speaker: 'Ada', text: 'Ada' },
        { speaker: null, text: '   ' },
      ]),
    ).toEqual([]);
  });
});

describe('findZoomCaptionsContainer', () => {
  it('uses the newest subtitle row when the labelled wrapper is unavailable', () => {
    const first = { textContent: 'First' } as Element;
    const latest = { textContent: 'Latest' } as Element;
    const root = {
      querySelector(selector: string) {
        return selector === ZOOM_CAPTIONS_CONTAINER_SELECTOR ? first : null;
      },
      querySelectorAll(selector: string) {
        return (selector === ZOOM_CAPTION_ROW_SELECTOR ? [first, latest] : []) as unknown as NodeListOf<Element>;
      },
    } as unknown as ParentNode;

    expect(findZoomCaptionsContainer(root)).toEqual({ status: 'found', element: latest });
  });
});
