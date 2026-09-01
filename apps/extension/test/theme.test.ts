import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSettings } from '../utils/settings';
import {
  applyTheme,
  resolveTheme,
  systemPrefersDark,
  watchTheme,
  type ThemeRoot,
} from '../utils/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function fakeRoot(): ThemeRoot {
  return { dataset: {}, style: {} };
}

interface FakeMedia {
  matches: boolean;
  listeners: Array<() => void>;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
  setMatches(matches: boolean): void;
}

function fakeMedia(matches = false): FakeMedia {
  const media: FakeMedia = {
    matches,
    listeners: [],
    addEventListener(_type, listener) {
      media.listeners.push(listener);
    },
    removeEventListener(_type, listener) {
      media.listeners = media.listeners.filter((l) => l !== listener);
    },
    setMatches(next) {
      media.matches = next;
      for (const listener of [...media.listeners]) listener();
    },
  };
  return media;
}

interface ChromeStub {
  storage: {
    local: { get: (keys: string | string[]) => Promise<Record<string, unknown>> };
    onChanged: {
      addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => void;
      removeListener: (fn: (changes: Record<string, unknown>, area: string) => void) => void;
    };
  };
}

/** Minimal `chrome.storage.local` standing in for the MV3 API in a node test env. */
function stubChrome(stored: Record<string, unknown>) {
  const handlers: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  const chrome: ChromeStub = {
    storage: {
      local: {
        get: async (_keys: string | string[]) => ({ ...stored }),
      },
      onChanged: {
        addListener: (fn) => {
          handlers.push(fn);
        },
        removeListener: (fn) => {
          const i = handlers.indexOf(fn);
          if (i >= 0) handlers.splice(i, 1);
        },
      },
    },
  };
  vi.stubGlobal('chrome', chrome);
  const emit = (key: string, newValue: unknown, area = 'local') => {
    for (const fn of [...handlers]) fn({ [key]: { newValue } }, area);
  };
  return { emit, handlerCount: () => handlers.length };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTheme', () => {
  it('follows the OS only for the system choice', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('stamps the resolved scheme on the root and keeps native controls in step', () => {
    const root = fakeRoot();
    expect(applyTheme('dark', false, root)).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');

    expect(applyTheme('light', true, root)).toBe('light');
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');

    expect(applyTheme('system', true, root)).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
  });
});

describe('systemPrefersDark', () => {
  it('reads the dark media query when matchMedia exists', () => {
    const media = fakeMedia(true);
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    expect(systemPrefersDark()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(DARK_QUERY);
  });

  it('is false without matchMedia', () => {
    expect(systemPrefersDark()).toBe(false);
  });
});

describe('normalizeSettings theme guard', () => {
  it('falls back to system for missing or corrupted values', () => {
    expect(normalizeSettings(undefined).theme).toBe('system');
    expect(normalizeSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(normalizeSettings({ theme: 'purple' as unknown as 'dark' }).theme).toBe('system');
    expect(normalizeSettings({ theme: 42 as unknown as 'dark' }).theme).toBe('system');
  });
});

describe('watchTheme', () => {
  it('paints the system default at once, then the stored preference', async () => {
    stubChrome({ settings: { theme: 'dark' } });
    vi.stubGlobal('matchMedia', vi.fn(() => fakeMedia(false)));
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });

    const off = watchTheme();
    // Synchronous first paint happens before storage resolves: system + light OS.
    expect(root.dataset.theme).toBe('light');
    await vi.waitFor(() => expect(root.dataset.theme).toBe('dark'));

    off();
  });

  it('repaints when the settings blob changes in storage', async () => {
    const { emit } = stubChrome({ settings: { theme: 'light' } });
    vi.stubGlobal('matchMedia', vi.fn(() => fakeMedia(false)));
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });
    const off = watchTheme();
    await vi.waitFor(() => expect(root.dataset.theme).toBe('light'));

    emit('settings', { theme: 'dark' });
    expect(root.dataset.theme).toBe('dark');

    // Corrupted writes normalise instead of leaving the UI undefined.
    emit('settings', { theme: 'neon' });
    expect(root.dataset.theme).toBe('light');

    // Other storage areas must not touch the theme.
    emit('settings', { theme: 'dark' }, 'sync');
    expect(root.dataset.theme).toBe('light');

    off();
    expect(root.dataset.theme).toBe('light');
    emit('settings', { theme: 'dark' });
    expect(root.dataset.theme).toBe('light');
  });

  it('follows the OS while the choice is system and ignores it once explicit', async () => {
    const media = fakeMedia(false);
    stubChrome({ settings: { theme: 'system' } });
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });

    const off = watchTheme();
    await vi.waitFor(() => expect(root.dataset.theme).toBe('light'));

    media.setMatches(true);
    expect(root.dataset.theme).toBe('dark');
    off();
  });

  it('survives a storage read failure', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: () => Promise.reject(new Error('Extension context invalidated')) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    vi.stubGlobal('matchMedia', vi.fn(() => fakeMedia(true)));
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });

    const off = watchTheme();
    expect(root.dataset.theme).toBe('dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(root.dataset.theme).toBe('dark');
    off();
  });
});
