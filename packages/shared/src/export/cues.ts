import type { TranscriptSegment } from '../types';
import { orderedSegments } from './order';

/** Cue text must not contain a blank line (that terminates the cue). */
export function sanitizeCueText(text: string): string {
  return text
    .replace(/\r\n|\r/g, '\n')
    .replace(/-->/g, '-- >')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

/** Escape WebVTT cue text and voice-span speaker names. */
export function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function isValidCueTiming(startMs: number, endMs: number): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

export interface PreparedCue {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
}

export function preparedCues(segments: readonly TranscriptSegment[]): PreparedCue[] {
  const out: PreparedCue[] = [];
  for (const seg of orderedSegments(segments)) {
    if (!isValidCueTiming(seg.startMs, seg.endMs)) continue;
    const text = sanitizeCueText(seg.text);
    if (!text) continue;
    const speaker = seg.speaker ? sanitizeCueText(seg.speaker) : undefined;
    out.push({
      startMs: seg.startMs,
      endMs: seg.endMs,
      text,
      speaker: speaker || undefined,
    });
  }
  return out;
}
