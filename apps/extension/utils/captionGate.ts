import type { MeetingSession } from '@scribetab/shared';
import type { CaptureState } from './messages';

export function isCaptionSenderAllowed(
  senderTabId: number | undefined,
  capturedTabId: number | null | undefined,
): boolean {
  return senderTabId != null && capturedTabId != null && senderTabId === capturedTabId;
}

export function acceptsCaptionEvents(captureState: unknown): captureState is CaptureState {
  return captureState === 'starting' || captureState === 'recording' || captureState === 'stopping';
}

export function freezeCaptionsOnly(
  wantCaptionsOnly: boolean,
  platform: MeetingSession['platform'],
): boolean {
  return wantCaptionsOnly && platform === 'meet';
}

export function captionsOnlyFallbackNotice(
  wantCaptionsOnly: boolean,
  platform: MeetingSession['platform'],
  sttConfigured: boolean,
): string | null {
  if (!wantCaptionsOnly || platform === 'meet') return null;
  return sttConfigured
    ? 'Captions-only is available on Google Meet only. Using speech-to-text for this tab.'
    : 'Captions-only is available on Google Meet only. This tab is not Meet — recording without live captions.';
}

export const LIVE_FUSION_MIN_MS = 2000;

/** 0 = run now; otherwise wait this many ms. */
export function fusionWaitMs(nowMs: number, lastFusionMs: number, minIntervalMs = LIVE_FUSION_MIN_MS): number {
  if (lastFusionMs <= 0) return 0;
  const elapsed = nowMs - lastFusionMs;
  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}
