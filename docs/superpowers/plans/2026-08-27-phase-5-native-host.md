# Phase 5 — Native host + MCP

**Goal:** Finish a meeting → files appear in `~/ScribeTab/meetings/` → an MCP client can read them.

**Branch:** `phase-5-native-host`

## Decisions

- `@scribetab/shared` compiles with `tsc` to `dist/` (ESM + `.d.ts`). `exports` sends **Node** to `dist` and **bundlers/WXT** to `src` (`node` vs `import` conditions) so the extension build does not require dist at typecheck time.
- One codebase in `apps/native-host`, two bins: `scribetab-host` (Chrome native messaging) and `scribetab-mcp` (MCP stdio).
- Protocol is the locked `HostSyncMessage` / `HostSyncAck` from the roadmap. Acks only after `sync_end` or on failure.
- Meetings are written under `meetings/.tmp-<uuid>/` and atomically renamed to `<YYYY-MM-DD>-<slug>/`. Hidden `.tmp-*` dirs are never listed.
- Slug: `[a-z0-9-]`, max 60, collision suffix `-2`, `-3`, …
- Audio chunks are decoded from base64, PCM appended (WAV headers stripped), then a single `audio.wav` is written on commit. Chunks > 8 MiB fail the sync.
- Development extension ID `cambjpbepplcihlihagiheggdkfcpmef` comes from the packed `key` in `apps/extension/wxt.config.ts`. `npx scribetab-host install --extension-id` overrides `allowed_origins`.
- Extension syncs from the service worker on `CAPTURE_ENDED` (not the offscreen capture path). "Sync all" retries `lastSession`. A missing host is stored as `nativeHostStatus` and shown as a hint — never retried in a loop.
- Tests spawn `dist/host.js` / `dist/mcp.js` with a temp `HOME` so they never touch the real `~/ScribeTab`.

## File map

| Path | Role |
| --- | --- |
| `packages/shared/tsconfig.build.json` + `package.json` `exports` | Node-consumable build |
| `apps/native-host/src/framing.ts` | LE uint32 + JSON |
| `apps/native-host/src/slug.ts` | slug + collision |
| `apps/native-host/src/sessionWriter.ts` | temp dir, audio, atomic rename |
| `apps/native-host/src/protocol.ts` | HostSync state machine |
| `apps/native-host/src/install.ts` | Chrome NMH manifest (macOS/Linux/Windows) |
| `apps/native-host/src/host.ts` | `scribetab-host` entry |
| `apps/native-host/src/mcp.ts` | MCP tools over the same directory |
| `apps/native-host/test/*.ts` | child-process protocol, slug/fs, MCP stdio |
| `apps/extension/utils/nativeSync.ts` | `connectNative('com.scribetab.host')` |
| `apps/extension/entrypoints/background.ts` | session meta + sync-on-finalize + `SYNC_ALL` |
| `apps/extension/wxt.config.ts` | `nativeMessaging` + packed `key` |

## Install locations

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.scribetab.host.json`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.scribetab.host.json`
- Windows: `%USERPROFILE%\ScribeTab\NativeMessagingHosts\com.scribetab.host.json` + `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.scribetab.host`
