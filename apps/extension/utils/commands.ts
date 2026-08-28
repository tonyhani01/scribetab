/** Manifest command names — keep in sync with wxt.config.ts `manifest.commands`. */
export const COMMAND_START_CAPTURE = 'start-capture';
export const COMMAND_STOP_CAPTURE = 'stop-capture';
export const COMMAND_OPEN_SIDE_PANEL = 'open-side-panel';
export const COMMAND_ADD_HIGHLIGHT = 'add-highlight';

export const COMMAND_DEFAULTS = {
  [COMMAND_START_CAPTURE]: 'Alt+Shift+R',
  [COMMAND_STOP_CAPTURE]: 'Alt+Shift+S',
  [COMMAND_OPEN_SIDE_PANEL]: 'Alt+Shift+T',
  [COMMAND_ADD_HIGHLIGHT]: 'Alt+Shift+H',
} as const;

/** Normalize user-entered highlight labels at the command boundary. */
export function normalizeHighlightLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  const normalized = label.trim().slice(0, 200);
  return normalized || undefined;
}

/** Return a live session-relative highlight time, or null when capture is invalid. */
export function liveHighlightStartMs(
  captureState: string | undefined,
  currentSessionId: string | undefined,
  sessionId: string,
  audioStartedAtMs: number | undefined,
  nowMs = Date.now(),
): number | null {
  if (captureState !== 'recording' || currentSessionId !== sessionId) return null;
  if (typeof audioStartedAtMs !== 'number' || !Number.isFinite(audioStartedAtMs)) return null;
  return Math.max(0, nowMs - audioStartedAtMs);
}
