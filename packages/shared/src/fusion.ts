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

/** Merge overlapping/adjacent [start, end) intervals. O(n log n). */
export function unionIntervals(intervals: readonly { startMs: number; endMs: number }[]): { startMs: number; endMs: number }[] {
  const valid = intervals
    .filter((iv) => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs) && iv.endMs > iv.startMs)
    .map((iv) => ({ startMs: iv.startMs, endMs: iv.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (valid.length === 0) return [];
  const out: { startMs: number; endMs: number }[] = [{ ...valid[0]! }];
  for (let i = 1; i < valid.length; i++) {
    const cur = valid[i]!;
    const last = out[out.length - 1]!;
    if (cur.startMs <= last.endMs) {
      if (cur.endMs > last.endMs) last.endMs = cur.endMs;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function clipToSegment(
  cap: CaptionCue,
  segStart: number,
  segEnd: number,
): { startMs: number; endMs: number } | null {
  const startMs = Math.max(segStart, cap.startMs);
  const endMs = Math.min(segEnd, cap.endMs);
  if (endMs <= startMs) return null;
  return { startMs, endMs };
}

/**
 * Attach `speaker` to each segment from caption overlap.
 * Majority-overlap wins; no overlap leaves `speaker` unchanged (typically undefined).
 * Per speaker, overlapping cues are unioned inside the segment so duplicates cannot
 * score more than the segment duration. Does not mutate the input arrays or objects.
 */
export function fuseSpeakers(
  segments: readonly TranscriptSegment[],
  captions: readonly CaptionCue[],
): TranscriptSegment[] {
  return segments.map((seg) => {
    const bySpeaker = new Map<string, CaptionCue[]>();
    for (const cap of captions) {
      const speaker = cap.speaker.trim();
      if (!speaker) continue;
      const clipped = clipToSegment(cap, seg.startMs, seg.endMs);
      if (!clipped) continue;
      const list = bySpeaker.get(speaker);
      const clippedCue = { ...cap, startMs: clipped.startMs, endMs: clipped.endMs };
      if (list) list.push(clippedCue);
      else bySpeaker.set(speaker, [clippedCue]);
    }
    if (bySpeaker.size === 0) return { ...seg };

    let bestSpeaker: string | undefined;
    let bestMs = -1;
    let bestFirst = Number.POSITIVE_INFINITY;
    for (const [speaker, cues] of bySpeaker) {
      const merged = unionIntervals(cues);
      let ms = 0;
      let firstStart = Number.POSITIVE_INFINITY;
      for (const iv of merged) {
        ms += iv.endMs - iv.startMs;
        if (iv.startMs < firstStart) firstStart = iv.startMs;
      }
      if (ms > bestMs || (ms === bestMs && firstStart < bestFirst)) {
        bestSpeaker = speaker;
        bestMs = ms;
        bestFirst = firstStart;
      }
    }
    return { ...seg, speaker: bestSpeaker };
  });
}
