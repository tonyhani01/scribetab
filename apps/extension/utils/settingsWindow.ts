const SETTINGS_WINDOW_WIDTH = 720;
const SETTINGS_WINDOW_HEIGHT = 860;

/**
 * Open the settings page in a standalone popup window instead of the
 * chrome://extensions embedded dialog that `openOptionsPage()` uses.
 * Reuses an already-open settings window. `chrome.windows` needs no
 * extra permission; `chrome.runtime.openOptionsPage` stays as a fallback.
 */
export async function openSettingsWindow(): Promise<void> {
  const url = chrome.runtime.getURL('options.html');
  try {
    const existing = await chrome.tabs.query({ url });
    const tab = existing[0];
    if (tab?.windowId !== undefined && tab.id !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return;
    }
    await chrome.windows.create({
      url,
      type: 'popup',
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
    });
  } catch {
    await chrome.runtime.openOptionsPage();
  }
}
