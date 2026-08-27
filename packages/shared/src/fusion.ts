import type { TranscriptSegment } from './types';

/** Session-relative caption interval used to attribute speakers onto audio segments. */
export interface CaptionCue {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || !Number.isFinite(bStart) || !Number.isFinite(bEnd)) {
    return 0;
  }
  if (aEnd <= aStart || bEnd <= bStart) return 0;
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Attach `speaker` to each segment from caption overlap.
 * Majority-overlap wins; no overlap leaves `speaker` unchanged (typically undefined).
 * Does not mutate the input arrays or objects.
 */
export function fuseSpeakers(
  segments: readonly TranscriptSegment[],
  captions: readonly CaptionCue[],
): TranscriptSegment[] {
  return segments.map((seg) => {
    const scores = new Map<string, { ms: number; firstStart: number }>();
    for (const cap of captions) {
      const speaker = cap.speaker.trim();
      if (!speaker) continue;
      const ms = overlapMs(seg.startMs, seg.endMs, cap.startMs, cap.endMs);
      if (ms <= 0) continue;
      const prev = scores.get(speaker);
      if (prev) {
        prev.ms += ms;
        if (cap.startMs < prev.firstStart) prev.firstStart = cap.startMs;
      } else {
        scores.set(speaker, { ms, firstStart: cap.startMs });
      }
    }
    if (scores.size === 0) return { ...seg };

    let bestSpeaker: string | undefined;
    let bestMs = -1;
    let bestFirst = Number.POSITIVE_INFINITY;
    for (const [speaker, { ms, firstStart }] of scores) {
      if (ms > bestMs || (ms === bestMs && firstStart < bestFirst)) {
        bestSpeaker = speaker;
        bestMs = ms;
        bestFirst = firstStart;
      }
    }
    return { ...seg, speaker: bestSpeaker };
  });
}
