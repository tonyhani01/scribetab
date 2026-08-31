import {
  SETTINGS_STORAGE_KEY,
  getSettings,
  normalizeSettings,
  type Settings,
  type ThemeChoice,
} from './settings';

/** The scheme actually painted on `<html>`; `system` always resolves to one of these. */
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The slice of `document.documentElement` this module touches (testable without a DOM). */
export interface ThemeRoot {
  dataset: { theme?: string };
  style: { colorScheme?: string };
}

/** The slice of `MediaQueryList` this module touches. */
export interface ThemeMedia {
  matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

export function resolveTheme(theme: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

function queryDark(): ThemeMedia | null {
  return typeof matchMedia === 'function' ? (matchMedia(DARK_QUERY) as unknown as ThemeMedia) : null;
}

export function systemPrefersDark(): boolean {
  return queryDark()?.matches === true;
}

/**
 * Paint the resolved scheme onto `<html>` as `data-theme`, which the token blocks
 * in `assets/theme.css` key off. Returns what was applied.
 */
export function applyTheme(
  theme: ThemeChoice,
  prefersDark: boolean = systemPrefersDark(),
  root: ThemeRoot = document.documentElement,
): ResolvedTheme {
  const resolved = resolveTheme(theme, prefersDark);
  root.dataset.theme = resolved;
  // Keeps native scrollbars, form controls and the canvas in step with the tokens.
  root.style.colorScheme = resolved;
  return resolved;
}

function subscribeMedia(media: ThemeMedia, onChange: () => void): () => void {
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }
  media.addListener?.(onChange);
  return () => media.removeListener?.(onChange);
}

/**
 * Apply the stored theme preference on load and keep it live: repaint when the
 * setting changes in `chrome.storage` (options page save) or when the OS flips
 * while the choice is `system`. Returns an unsubscribe function; the extension
 * surfaces live as long as their page, so callers may ignore it.
 */
export function watchTheme(): () => void {
  const media = queryDark();
  let theme: ThemeChoice = 'system';

  const paint = () => {
    if (typeof document === 'undefined') return;
    applyTheme(theme, media?.matches === true);
  };
  // Synchronous first paint with the system default, before storage resolves.
  paint();

  const offMedia = media ? subscribeMedia(media, paint) : () => {};
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return;
    theme = normalizeSettings(changes[SETTINGS_STORAGE_KEY]?.newValue as Partial<Settings> | undefined).theme;
    paint();
  };
  chrome.storage.onChanged.addListener(onStorage);
  void getSettings()
    .then((s) => {
      theme = s.theme;
      paint();
    })
    // Storage can be unavailable (or the extension can reload mid-read); the
    // system default painted above is already on screen, so there is nothing to report.
    .catch(() => {});

  return () => {
    offMedia();
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
