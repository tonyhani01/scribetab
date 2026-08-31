import type { CaptureState } from './messages';
import { platformFromUrl } from './platform';

/** Shift the wall-clock origin so session-relative time excludes a completed pause. */
export function captureOriginAfterResume(
  audioStartedAtMs: number | undefined,
  capturePausedAtMs: number | undefined,
  resumedAtMs: number,
): number | undefined {
  if (audioStartedAtMs === undefined) return undefined;
  const pausedAtMs = capturePausedAtMs ?? resumedAtMs;
  return audioStartedAtMs + Math.max(0, resumedAtMs - pausedAtMs);
}

/** REC? is meet/teams/zoom only — YouTube stays capturable via the popup. */
export function isBadgeInviteUrl(url: string | undefined): boolean {
  const p = platformFromUrl(url);
  return p === 'meet' || p === 'teams' || p === 'zoom';
}

export function badgeText(opts: {
  url?: string;
  tabId?: number;
  captureState?: CaptureState;
  capturedTabId?: number | null;
}): string {
  if (
    opts.tabId != null &&
    opts.capturedTabId === opts.tabId &&
    opts.captureState === 'paused'
  ) {
    return '⏸';
  }
  if (
    opts.tabId != null &&
    opts.capturedTabId === opts.tabId &&
    (opts.captureState === 'recording' || opts.captureState === 'starting')
  ) {
    return 'REC';
  }
  if (isBadgeInviteUrl(opts.url)) return 'REC?';
  return '';
}

export async function applyBadge(tabId: number, text: string): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: text === 'REC?' ? '#c45c26' : '#b00020',
    });
  }
}

let badgeToken = 0;
const tabToken = new Map<number, number>();

export async function refreshActionBadge(tabId: number, url?: string): Promise<void> {
  const token = ++badgeToken;
  tabToken.set(tabId, token);
  const { captureState, capturedTabId } = await chrome.storage.local.get([
    'captureState',
    'capturedTabId',
  ]);
  if (tabToken.get(tabId) !== token) return;
  let resolved = url;
  if (resolved === undefined) {
    try {
      resolved = (await chrome.tabs.get(tabId)).url;
    } catch {
      resolved = undefined;
    }
  }
  if (tabToken.get(tabId) !== token) return;
  const text = badgeText({
    url: resolved,
    tabId,
    captureState: captureState as CaptureState | undefined,
    capturedTabId: typeof capturedTabId === 'number' ? capturedTabId : null,
  });
  await applyBadge(tabId, text);
}

export async function refreshActiveTabBadge(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id == null) return;
  await refreshActionBadge(tab.id, tab.url);
}

/** Last-error for the popup plus a transient "!" on the active tab. */
export async function surfaceCommandError(message: string): Promise<void> {
  console.warn('[scribetab]', message);
  await chrome.storage.local.set({ lastError: message });
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id == null) return;
  const token = ++badgeToken;
  tabToken.set(tab.id, token);
  await applyBadge(tab.id, '!');
}
