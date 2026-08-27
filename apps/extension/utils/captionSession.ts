import { fuseSpeakers, type CaptionCue, type TranscriptSegment } from '@scribetab/shared';
import { deleteCuesForSession, getCuesForSession, putCue, type CaptionCueRow } from './captionCueStore';
import { appendCue, toSessionRelative } from './captionTimeline';

const timelines = new Map<string, CaptionCue[]>();

function rowToCue(row: CaptionCueRow): CaptionCue {
  return {
    speaker: row.speaker,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
  };
}

export function resetCaptionTimeline(sessionId: string): void {
  timelines.set(sessionId, []);
}

export async function clearCaptionTimeline(sessionId: string): Promise<void> {
  timelines.delete(sessionId);
  await deleteCuesForSession(sessionId);
}

export function captionCuesFor(sessionId: string): CaptionCue[] {
  return timelines.get(sessionId) ?? [];
}

export async function rehydrateCaptionTimeline(sessionId: string): Promise<void> {
  const rows = await getCuesForSession(sessionId);
  timelines.set(sessionId, rows.map(rowToCue));
}

export async function ingestCaptionEvent(
  sessionId: string,
  event: { speaker: string; text: string; timestampMs: number; endMs?: number },
  originMs: number,
): Promise<CaptionCue | null> {
  const text = event.text.trim();
  if (!text) return null;
  const rel = toSessionRelative(event.timestampMs, event.endMs ?? event.timestampMs, originMs);
  if (!rel) return null;
  const cue: CaptionCue = {
    speaker: event.speaker.trim(),
    text,
    startMs: rel.startMs,
    endMs: rel.endMs,
  };
  let list = timelines.get(sessionId);
  if (!list) {
    list = [];
    timelines.set(sessionId, list);
  }
  appendCue(list, cue);
  await putCue({
    id: crypto.randomUUID(),
    sessionId,
    speaker: cue.speaker,
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
  });
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
