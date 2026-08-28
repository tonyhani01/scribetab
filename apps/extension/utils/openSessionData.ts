import type { HighlightMoment, TranscriptSegment } from '@scribetab/shared';
import { getHighlightsForSession } from './highlightStore';
import { getSegments } from './segmentStore';

export interface OpenSessionLoaders {
  loadSegments: (sessionId: string) => Promise<TranscriptSegment[]>;
  loadHighlights: (sessionId: string) => Promise<HighlightMoment[]>;
}

export interface OpenSessionData {
  segments: TranscriptSegment[];
  highlights: HighlightMoment[];
  segmentsError?: unknown;
  highlightsError?: unknown;
}

/** Read detail panes independently so one store failure does not hide the other. */
export async function loadOpenSessionData(
  sessionId: string,
  loaders: OpenSessionLoaders = { loadSegments: getSegments, loadHighlights: getHighlightsForSession },
): Promise<OpenSessionData> {
  const [segments, highlights] = await Promise.allSettled([
    loaders.loadSegments(sessionId),
    loaders.loadHighlights(sessionId),
  ]);
  return {
    segments: segments.status === 'fulfilled' ? segments.value : [],
    highlights: highlights.status === 'fulfilled' ? highlights.value : [],
    ...(segments.status === 'rejected' ? { segmentsError: segments.reason } : {}),
    ...(highlights.status === 'rejected' ? { highlightsError: highlights.reason } : {}),
  };
}
