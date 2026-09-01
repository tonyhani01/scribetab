import type { TranscriptSegment } from './types.js';

/** Label used for segments with no speaker attribution. */
export const UNKNOWN_SPEAKER = 'Unknown';

export interface TalkTimeEntry {
  speaker: string;
  /** Seconds spoken, summed over that speaker's segments. */
  ms: number;
  /** Share of all measured talk time, 0–100, rounded to one decimal. */
  pct: number;
}

/**
 * Wall-clock duration credited to a segment. Inverted or non-finite spans
 * count as zero so corrupted storage can never inflate a speaker's total.
 */
export function segmentDurationMs(
  segment: Pick<TranscriptSegment, 'startMs' | 'endMs'>,
): number {
  const { startMs, endMs } = segment;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

/**
 * Talk time per speaker, biggest voice first (same ordering convention as
 * `distinctSpeakers`). Durations are summed per segment, so a caption row and
 * an audio row that overlap are both counted — a simplification that is fine
 * for a "who talked most" bar, and keeps the math explainable.
 */
export function computeTalkTime(segments: readonly TranscriptSegment[]): TalkTimeEntry[] {
  const totals = new Map<string, number>();
  for (const segment of segments) {
    const ms = segmentDurationMs(segment);
    if (ms === 0) continue;
    const speaker = segment.speaker?.trim() || UNKNOWN_SPEAKER;
    totals.set(speaker, (totals.get(speaker) ?? 0) + ms);
  }

  let total = 0;
  for (const ms of totals.values()) total += ms;
  if (total <= 0) return [];

  return [...totals.entries()]
    .map(([speaker, ms]) => ({
      speaker,
      ms,
      pct: Math.round((ms / total) * 1000) / 10,
    }))
    .sort((a, b) => b.ms - a.ms || a.speaker.localeCompare(b.speaker));
}
