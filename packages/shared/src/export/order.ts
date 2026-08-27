import type { TranscriptSegment } from '../types';

/** Copy and sort by session-relative start; does not mutate `segments`. */
export function orderedSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments.slice().sort((a, b) => a.startMs - b.startMs);
}
