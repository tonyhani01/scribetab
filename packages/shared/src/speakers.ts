import type { HighlightKind, HighlightMoment, TranscriptSegment } from './types.js';

/** Canonical kind order for UI chips and normalization. */
export const HIGHLIGHT_KINDS: readonly HighlightKind[] = [
  'highlight',
  'action',
  'decision',
  'question',
  'note',
];

/** Emoji prefix per highlight kind, used by the side panel and exports. */
export const HIGHLIGHT_KIND_EMOJI: Record<HighlightKind, string> = {
  highlight: '⭐',
  action: '✅',
  decision: '🔴',
  question: '❓',
  note: '📝',
};

/** Emoji for a highlight kind; rows stored before kinds existed get ⭐. */
export function highlightKindEmoji(kind: HighlightKind | undefined): string {
  return HIGHLIGHT_KIND_EMOJI[kind ?? 'highlight'];
}

/**
 * Apply manual speaker renames to segments. Does not mutate inputs.
 * Empty/whitespace display names are ignored (keeps the original label).
 */
export function applySpeakerNames(
  segments: readonly TranscriptSegment[],
  names: Record<string, string> | undefined,
): TranscriptSegment[] {
  if (!names) return segments.map((s) => ({ ...s }));
  return segments.map((s) => {
    if (!s.speaker) return { ...s };
    const renamed = names[s.speaker];
    return typeof renamed === 'string' && renamed.trim() ? { ...s, speaker: renamed.trim() } : { ...s };
  });
}

/** Distinct caption speaker labels present in segments, most segments first. */
export function distinctSpeakers(segments: readonly TranscriptSegment[]): string[] {
  const counts = new Map<string, number>();
  for (const s of segments) {
    const sp = s.speaker?.trim();
    if (!sp) continue;
    counts.set(sp, (counts.get(sp) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** Validate a rename map: trims values, drops empties and identity renames. */
export function normalizeSpeakerNames(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    const val = typeof v === 'string' ? v.trim() : '';
    if (key && val && key !== val) out[key] = val;
  }
  return out;
}

/** Ordered highlights with text of the nearest segment attached (for display/export). */
export interface HighlightWithContext {
  highlight: HighlightMoment;
  segment?: TranscriptSegment;
}

export function highlightsWithContext(
  highlights: readonly HighlightMoment[],
  segments: readonly TranscriptSegment[],
): HighlightWithContext[] {
  const sorted = [...highlights].sort((a, b) => a.startMs - b.startMs);
  const segs = [...segments].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((hl) => {
    // Nearest segment by |start - hl.startMs| (highlights land mid-speech).
    let best: TranscriptSegment | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const s of segs) {
      const d = Math.abs(s.startMs - hl.startMs);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return { highlight: hl, segment: best };
  });
}
