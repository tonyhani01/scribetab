import type { CaptureState } from './messages';
import { isMeetingPlatform } from './platform';

export function badgeText(opts: {
  url?: string;
  tabId?: number;
  captureState?: CaptureState;
  capturedTabId?: number | null;
}): string {
  if (
    opts.tabId != null &&
    opts.capturedTabId === opts.tabId &&
    (opts.captureState === 'recording' || opts.captureState === 'starting')
  ) {
    return 'REC';
  }
  if (isMeetingPlatform(opts.url)) return 'REC?';
  return '';
}

export async function applyBadge(tabId: number, text: string): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: text === 'REC' ? '#b00020' : '#c45c26',
    });
  }
}

export async function refreshActionBadge(tabId: number, url?: string): Promise<void> {
  const { captureState, capturedTabId } = await chrome.storage.local.get([
    'captureState',
    'capturedTabId',
  ]);
  let resolved = url;
  if (resolved === undefined) {
    try {
      resolved = (await chrome.tabs.get(tabId)).url;
    } catch {
      resolved = undefined;
    }
  }
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
