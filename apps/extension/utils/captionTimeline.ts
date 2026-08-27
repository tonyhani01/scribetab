import type { CaptionCue } from '@scribetab/shared';

/**
 * Convert wall-clock caption times to session-relative using the audio origin.
 * Cues that start before the origin are dropped (not clamped).
 */
export function toSessionRelative(
  wallStartMs: number,
  wallEndMs: number,
  originMs: number,
): { startMs: number; endMs: number } | null {
  if (!Number.isFinite(wallStartMs) || !Number.isFinite(wallEndMs) || !Number.isFinite(originMs)) {
    return null;
  }
  if (wallStartMs < originMs) return null;
  const startMs = wallStartMs - originMs;
  const endMs = Math.max(startMs + 1, wallEndMs - originMs);
  return { startMs, endMs };
}

/** Append in place — callers must not keep an ever-copied timeline. */
export function appendCue(cues: CaptionCue[], cue: CaptionCue): CaptionCue[] {
  if (!cue.text.trim()) return cues;
  cues.push(cue);
  return cues;
}
