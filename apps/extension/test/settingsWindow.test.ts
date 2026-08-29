import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSettingsWindow } from '../utils/settingsWindow';

const URL = 'chrome-extension://abc/options.html';

function stubChrome(overrides: Record<string, unknown> = {}) {
  const chromeMock = {
    runtime: { getURL: vi.fn(() => URL), openOptionsPage: vi.fn(async () => undefined) },
    tabs: { query: vi.fn(async () => []), update: vi.fn(async () => undefined) },
    windows: { create: vi.fn(async () => undefined), update: vi.fn(async () => undefined) },
    ...overrides,
  };
  vi.stubGlobal('chrome', chromeMock);
  return chromeMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('openSettingsWindow', () => {
  it('opens options.html in a standalone popup window', async () => {
    const c = stubChrome();
    await openSettingsWindow();
    expect(c.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL, type: 'popup' }),
    );
    expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
  });

  it('focuses an existing settings window instead of opening another', async () => {
    const c = stubChrome();
    c.tabs.query.mockResolvedValue([{ id: 7, windowId: 3 }] as never);
    await openSettingsWindow();
    expect(c.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(c.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(c.windows.create).not.toHaveBeenCalled();
  });

  it('falls back to openOptionsPage when windows API fails', async () => {
    const c = stubChrome();
    c.windows.create.mockRejectedValue(new Error('no windows'));
    await openSettingsWindow();
    expect(c.runtime.openOptionsPage).toHaveBeenCalled();
  });
});
