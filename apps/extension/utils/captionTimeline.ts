import type { CaptionCue } from '@scribetab/shared';

export function toSessionRelative(
  wallStartMs: number,
  wallEndMs: number,
  sessionStartedAtMs: number,
): { startMs: number; endMs: number } {
  const startMs = Math.max(0, wallStartMs - sessionStartedAtMs);
  const endMs = Math.max(startMs + 1, wallEndMs - sessionStartedAtMs);
  return { startMs, endMs };
}

export function appendCue(cues: readonly CaptionCue[], cue: CaptionCue): CaptionCue[] {
  return [...cues, cue];
}
