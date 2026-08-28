import type { TranscriptSegment } from '@scribetab/shared';

/** Merge a base store read with live rows; incoming rows win by segment id. */
export function mergeSegments(
  base: readonly TranscriptSegment[],
  incoming: readonly TranscriptSegment[],
): TranscriptSegment[] {
  const byId = new Map(base.map((segment) => [segment.id, segment]));
  for (const segment of incoming) byId.set(segment.id, segment);
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs);
}
