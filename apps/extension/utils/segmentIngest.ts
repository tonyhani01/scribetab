import { applyReplacementsToSegments, redactSegments } from '@scribetab/shared';

export interface SegmentIngestRedaction {
  extraTerms: string[];
}

/** Validate the active capture's restart-safe correction snapshot. */
export function normalizeVocabReplacements(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return [];
  const replacements: [string, string][] = [];
  for (const pair of value) {
    if (
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      pair[0].length > 0 &&
      typeof pair[1] === 'string'
    ) {
      replacements.push([pair[0], pair[1]]);
    }
  }
  return replacements;
}

/** Prepare transcript segments in privacy-safe order immediately before storage. */
export function prepareSegmentsForStorage<T extends { text: string; speaker?: string }>(
  segments: T[],
  redaction: SegmentIngestRedaction | null,
  replacements: [string, string][],
): T[] {
  const redacted = redaction
    ? redactSegments(segments, { extraTerms: redaction.extraTerms })
    : segments;
  return applyReplacementsToSegments(redacted, replacements);
}

/** Fusion only attaches speakers; its transcript text was corrected at initial ingest. */
export function prepareFusedSegmentsForStorage<T extends { text: string; speaker?: string }>(
  segments: T[],
  redaction: SegmentIngestRedaction | null,
): T[] {
  return redaction
    ? redactSegments(segments, { extraTerms: redaction.extraTerms })
    : segments;
}
