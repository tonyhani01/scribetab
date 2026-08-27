# Phase 9 — Polish & ship

**Date:** 2026-08-27
**Status:** Implemented
**Roadmap:** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md` Phase 9
**Branch:** `phase-9-polish`

## Goal

UX polish, Playwright e2e, docs, and a store-submittable zip at extension
version 1.0.0. Locked types in `packages/shared/src/types.ts` are unchanged.
No git tag.

## File map

| Area | Change |
| --- | --- |
| Consent | `settings.consentReminder` (default on); `components/ConsentBanner.tsx` in popup + side panel; Don’t show again persists |
| Badge | `utils/actionBadge.ts`; `tabs` permission; `REC?` on known meeting URLs, `REC` while capturing that tab |
| Hotkeys | `chrome.commands` in `wxt.config.ts`; handled in the service worker |
| Options | Grouped Capture / Transcription / Intelligence / Redaction / Sync; inline URL/key checks; Test connection (permission-aware) |
| Empty/error | Popup not-capturable; Live empty / unconfigured / missing permission; Library empty + empty search; `humanError()` so UI never shows stacks |
| e2e | `apps/extension/e2e/` persistent Chromium + `--load-extension`; CI step |
| Docs | Root README, CONTRIBUTING, per-package READMEs, `docs/store-listing.md` |
| Packaging | `pnpm --filter @scribetab/extension zip`; version 1.0.0 |

## Permissions

Added **`tabs`**. `chrome.tabs.onActivated` / `onUpdated` fire without it, but
`Tab.url` is hidden unless the extension has `tabs` or matching host
permissions. Host permissions on Meet/Teams/Zoom/YouTube would allow injecting
into those sites; `tabs` only reads URL/title for the badge and capturable
check. That is the least-privilege option.

`chrome.commands` needs no extra permission.

## Hotkey conflicts

Suggested keys (Alt+Shift+R / S / T) are hints. Chrome silently skips a
suggestion that collides with a built-in shortcut or another extension. Users
rebind at `chrome://extensions/shortcuts`. Documented in the root README and
the extension README.

## Test connection

STT: `GET {endpoint}/models` (Deepgram: `{endpoint}/v1/projects` with `Token`).
LLM: `GET {endpoint}/models`. Requests host permission for that origin first.
No audio is uploaded.

## e2e

Hermetic: Playwright `channel: 'chromium'` (full Chrome, not headless shell),
`--load-extension` on `.output/chrome-mv3`, HTTP(S) aborted. Covers service
worker, popup, options save, side-panel empty state.

## Deviations

- No product screenshots in-repo; README points at `docs/screenshots/` as a
  place to drop them later (brief: do not fabricate screenshots).
- No `v1.0.0` git tag (brief).
- `tabs` added as justified above.
