# @scribetab/extension

MV3 Chrome extension (WXT + Preact). Popup, options, side panel, offscreen
recorder, background service worker, and a Meet captions content script.

## Scripts

```
pnpm --filter @scribetab/extension dev
pnpm --filter @scribetab/extension build
pnpm --filter @scribetab/extension test
pnpm --filter @scribetab/extension e2e
pnpm --filter @scribetab/extension zip
```

Unpacked output: `.output/chrome-mv3`. Load that folder in
`chrome://extensions`. Zip output: `.output/scribetab-<version>-chrome.zip`.

## Hotkeys

Declared in `wxt.config.ts` as `chrome.commands`. Suggested keys are
Alt+Shift+R / S / T. Chrome drops a suggestion when it collides with a built-in
or another extension — users rebind at `chrome://extensions/shortcuts`.

## Permissions

See [`docs/store-listing.md`](../../docs/store-listing.md). The `tabs`
permission is used only to read the active tab URL for the meeting badge
(`REC?`) and to decide whether the popup can offer capture. Meeting-site host
permissions are not added for the badge.

## Screenshots

Place optional product shots in `docs/screenshots/` (not shipped).
