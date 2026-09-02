import { CHUNK_MAX_SECONDS } from './chunker.js';
import { fuseSpeakers, type CaptionCue } from './fusion.js';
import type { TranscriptSegment } from './types.js';

/** A speaker-bearing interval from a whole-file diarization pass. */
export interface DiarizedSegment {
  startMs: number;
  endMs: number;
  text?: string;
  speaker?: string;
}

/**
 * Overlay session-global speaker labels from a whole-file diarization pass onto
 * the live segments. Segments that already carry a speaker (caption fusion or a
 * manual rename produced a real name) keep it — STT "Speaker N" never wins over
 * a real name. Pure: inputs are not mutated.
 */
export function reconcileDiarization(
  live: readonly TranscriptSegment[],
  diarized: readonly DiarizedSegment[],
): TranscriptSegment[] {
  const cues: CaptionCue[] = [];
  for (const d of diarized) {
    const speaker = d.speaker?.trim();
    if (!speaker) continue;
    cues.push({ speaker, text: d.text ?? '', startMs: d.startMs, endMs: d.endMs });
  }
  const fused = fuseSpeakers(live, cues);
  return live.map((seg, i) => {
    if (seg.speaker) return { ...seg };
    const speaker = fused[i]?.speaker;
    return speaker ? { ...seg, speaker } : { ...seg };
  });
}

/**
 * Whole-file diarization is worth its extra STT call only for providers that
 * return session-global speaker labels from one batch request. ElevenLabs only:
 * the Google adapter inlines audio as base64 JSON, so a whole meeting would need
 * a Files API upload first.
 */
export function wholeFileDiarizationSupported(opts: {
  providerId: string;
  diarize: boolean | undefined;
}): boolean {
  return opts.providerId === 'elevenlabs' && opts.diarize !== false;
}

/**
 * Cheap gate plus the duration check: a meeting that fit in a single chunk was
 * already diarized as a whole, so a second pass would only cost money.
 */
export function shouldRunWholeFileDiarization(opts: {
  providerId: string;
  diarize: boolean | undefined;
  audioSeconds: number;
}): boolean {
  if (!wholeFileDiarizationSupported(opts)) return false;
  return Number.isFinite(opts.audioSeconds) && opts.audioSeconds > CHUNK_MAX_SECONDS;
}
