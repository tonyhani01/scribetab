/**
 * Library playback: turn a session's retained `chunkStore` rows into a single
 * playable object URL.
 *
 * The byte-level assembly is deliberately the *same* code path the popup's
 * "Download recording" button uses (`utils/assemble.ts` → `assembleWavChunks`
 * for PCM, `remuxOggOpusChunks` for Opus/OGG), so playback and download can
 * never disagree about what a session's audio is. Callers here only add the
 * object-URL lifecycle on top.
 */

import { assembleRecording } from './assemble';

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
/** Arrow-key nudge distance, in milliseconds. */
export const SEEK_STEP_MS = 5000;

export interface SessionAudioBlob {
  blob: Blob;
  mimeType: string;
  /**
   * Seconds of audio, derived from the stored chunk metadata. Object URLs for
   * streamed OGG sometimes report `Infinity` until the element is seeked, so
   * the player needs a value it can trust.
   */
  seconds: number;
}

export interface SessionAudioSource {
  url: string;
  mimeType: string;
}

/**
 * Assemble the session's audio without creating an object URL.
 *
 * Returns null when there is nothing to play — either no rows survived
 * retention/quota pruning, or the rows carried no PCM samples. Throws when the
 * session mixes WAV and Opus rows, because there is no honest single container
 * for that; the caller surfaces it as an error.
 */
export async function loadSessionAudio(sessionId: string): Promise<SessionAudioBlob | null> {
  const { blob, seconds } = await assembleRecording(sessionId);
  if (blob.size === 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { blob, mimeType: blob.type, seconds };
}

/**
 * Assemble the session's audio as a blob URL for an `<audio>` element.
 * The caller owns the URL and must pass it to `revokeSessionAudio` when the
 * session closes or is replaced.
 */
export async function assembleSessionAudio(sessionId: string): Promise<SessionAudioSource | null> {
  const audio = await loadSessionAudio(sessionId);
  if (!audio) return null;
  return {
    url: URL.createObjectURL(audio.blob),
    mimeType: audio.mimeType,
  };
}

/** Release an object URL from `assembleSessionAudio`. Safe to call twice. */
export function revokeSessionAudio(url: string): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Already revoked, or the host page has no object-URL support — nothing to leak.
  }
}

export interface PlaybackKeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export type PlaybackKeyAction = 'toggle' | 'seek-back' | 'seek-forward';

/**
 * Map a keydown to a player command, or null to leave the key alone.
 * Typing takes priority: text inputs, textareas, selects and contenteditable
 * nodes (segment editors) keep their own Escape/arrow behaviour.
 */
export function playbackKeyAction(
  key: string,
  target: PlaybackKeyTarget | null | undefined,
): PlaybackKeyAction | null {
  if (target && (target.isContentEditable || TYPING_TAGS.has((target.tagName ?? '').toUpperCase()))) {
    return null;
  }
  if (key === 'Escape') return 'toggle';
  if (key === 'ArrowLeft') return 'seek-back';
  if (key === 'ArrowRight') return 'seek-forward';
  return null;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Index of the segment to mark `st-segment--playing`, or -1 while playback is
 * outside every segment. If segments overlap, the most recently started one
 * wins.
 */
export function playingSegmentIndex(
  segments: readonly { startMs: number; endMs: number }[],
  timeMs: number,
): number {
  if (!Number.isFinite(timeMs)) return -1;
  let active = -1;
  let activeStart = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < segments.length; i++) {
    const { startMs: start, endMs: end } = segments[i]!;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > timeMs || timeMs >= end) continue;
    if (start > activeStart) {
      activeStart = start;
      active = i;
    }
  }
  return active;
}
