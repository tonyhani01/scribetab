/** Delayed CAPTURE_ENDED may only mutate live capture state for its own session. */
export function isLiveSession(endedSessionId: string, currentSessionId: unknown): boolean {
  return typeof endedSessionId === 'string' && endedSessionId === currentSessionId;
}

/**
 * OFFSCREEN_STOP with a sessionId only tears down that session. Omitting
 * sessionId is a force-stop (start-retry recovery of a leftover engine).
 */
export function offscreenStopApplies(
  stopSessionId: string | undefined,
  liveSessionId: string,
): boolean {
  if (!stopSessionId) return true;
  return !liveSessionId || stopSessionId === liveSessionId;
}

/** Unreachable / null offscreen probe is a failure, not a clean complete. */
export function statusFromOffscreenAck(res: { ok: boolean } | null): 'complete' | 'failed' {
  return res && res.ok ? 'complete' : 'failed';
}

export function statusFromCaptureEnded(error?: string): 'complete' | 'failed' {
  return error ? 'failed' : 'complete';
}

export function bootLiveRecording(captureState: unknown, offscreenAlive: boolean): boolean {
  return captureState === 'recording' && offscreenAlive;
}

export function bootShouldIdle(captureState: unknown, offscreenAlive: boolean): boolean {
  if (bootLiveRecording(captureState, offscreenAlive)) return false;
  return captureState === 'starting' || captureState === 'stopping' || captureState === 'recording';
}

export function bootExceptId(
  captureState: unknown,
  currentSessionId: unknown,
  offscreenAlive: boolean,
): string | undefined {
  if (!bootLiveRecording(captureState, offscreenAlive)) return undefined;
  return typeof currentSessionId === 'string' ? currentSessionId : undefined;
}
