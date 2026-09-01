import type { CaptionSnapshot } from './captionReduce';

/**
 * Fragile Zoom web-client DOM selectors. Zoom may change these without notice;
 * keep every caption selector in this module so failures remain isolated.
 */
export const ZOOM_CAPTIONS_CONTAINER_SELECTOR =
  '[aria-label="Live Transcription"], .live-transcription-subtitle__item';
const ZOOM_LABELLED_CONTAINER_SELECTOR = '[aria-label="Live Transcription"]';
export const ZOOM_CAPTION_ROW_SELECTOR = '.live-transcription-subtitle__item';
export const ZOOM_SPEAKER_SELECTOR = '.live-transcription-subtitle__name';

export interface ZoomCaptionRow {
  speaker: string | null | undefined;
  text: string;
}

export type ZoomCaptionsContainerState =
  | { status: 'found'; element: Element }
  | { status: 'not_found' };

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripSpeakerPrefix(text: string, speaker: string): string {
  if (!speaker || !text.startsWith(speaker)) return text;
  return text.slice(speaker.length).replace(/^[\s:：\-–—]+/, '').trim();
}

export function reduceZoomCaptionRows(rows: readonly ZoomCaptionRow[]): CaptionSnapshot[] {
  const snapshots: CaptionSnapshot[] = [];
  for (const row of rows) {
    const providedSpeaker = normalizeText(row.speaker ?? '');
    const text = stripSpeakerPrefix(normalizeText(row.text), providedSpeaker);
    if (!text) continue;
    snapshots.push({ speaker: providedSpeaker || 'Speaker', text });
  }
  return snapshots;
}

export function findZoomCaptionsContainer(root: ParentNode): ZoomCaptionsContainerState {
  const labelledContainer = root.querySelector(ZOOM_LABELLED_CONTAINER_SELECTOR);
  if (labelledContainer) return { status: 'found', element: labelledContainer };
  const rows = [...root.querySelectorAll(ZOOM_CAPTION_ROW_SELECTOR)];
  const element = rows[rows.length - 1] ?? null;
  return element ? { status: 'found', element } : { status: 'not_found' };
}

export function parseZoomCaptionNodes(container: Element): CaptionSnapshot[] {
  const elements = container.matches(ZOOM_CAPTION_ROW_SELECTOR)
    ? [container]
    : [...container.querySelectorAll(ZOOM_CAPTION_ROW_SELECTOR)];
  const rows = elements.length > 0 ? elements : [container];
  return reduceZoomCaptionRows(
    rows.map((row) => ({
      speaker: row.querySelector(ZOOM_SPEAKER_SELECTOR)?.textContent,
      text: row.textContent ?? '',
    })),
  );
}
