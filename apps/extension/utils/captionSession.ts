import { fuseSpeakers, type CaptionCue, type TranscriptSegment } from '@scribetab/shared';
import { appendCue, toSessionRelative } from './captionTimeline';

const timelines = new Map<string, CaptionCue[]>();

export function resetCaptionTimeline(sessionId: string): void {
  timelines.set(sessionId, []);
}

export function clearCaptionTimeline(sessionId: string): void {
  timelines.delete(sessionId);
}

export function captionCuesFor(sessionId: string): CaptionCue[] {
  return timelines.get(sessionId) ?? [];
}

export function ingestCaptionEvent(
  sessionId: string,
  event: { speaker: string; text: string; timestampMs: number; endMs?: number },
  sessionStartedAtMs: number,
): CaptionCue {
  const { startMs, endMs } = toSessionRelative(
    event.timestampMs,
    event.endMs ?? event.timestampMs,
    sessionStartedAtMs,
  );
  const cue: CaptionCue = {
    speaker: event.speaker.trim(),
    text: event.text.trim(),
    startMs,
    endMs,
  };
  timelines.set(sessionId, appendCue(captionCuesFor(sessionId), cue));
  return cue;
}

export function captionCueToSegment(
  sessionId: string,
  cue: CaptionCue,
  id: string,
): TranscriptSegment {
  return {
    id,
    sessionId,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    speaker: cue.speaker || undefined,
    source: 'captions',
  };
}

export function fuseWithCaptions(
  segments: readonly TranscriptSegment[],
  sessionId: string,
): TranscriptSegment[] {
  return fuseSpeakers(segments, captionCuesFor(sessionId));
}
