# Phase 8 — Integrations: Obsidian, Notion, NotebookLM

**Date:** 2026-08-27
**Status:** Implemented
**Roadmap:** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md` Phase 8
**Branch:** `phase-8-integrations`

## Goal

On native-host sync, optionally copy the meeting Markdown into an Obsidian vault and/or create a Notion page. In the extension Library, “Export for NotebookLM” downloads an upload-ready Markdown file (NotebookLM has no public API).

## File map

### Native host

| File | Role |
|---|---|
| `src/paths.ts` | Per-OS user data dir + `config.json` path |
| `src/config.ts` | Load/save/validate host config; `config get/set` keys |
| `src/obsidian.ts` | Vault check, `ScribeTab/<date>-<slug>.md`, sessionId frontmatter |
| `src/notion.ts` | Pure block builder + `pages.create` / `blocks.children.append` via `fetch` |
| `src/integrations.ts` | Best-effort post-commit runner (never throws) |
| `src/protocol.ts` | After `commitSync`, run integrations; attach errors to ack |
| `src/cli.ts` | `scribetab-host config get/set` (no prompts) |

### Shared / extension

| File | Role |
|---|---|
| `packages/shared/src/export/notebooklm.ts` | Pure NotebookLM Markdown exporter |
| `apps/extension/utils/exportDownload.ts` | `notebooklm` format → `.md` download |
| `apps/extension/entrypoints/sidepanel/main.tsx` | Library button |
| `apps/extension/entrypoints/options/main.tsx` | Doc-only integrations section |
| `apps/extension/utils/nativeSync.ts` | Forwards `summaryMarkdown` when present |

Locked types in `packages/shared/src/types.ts` were not changed.

## Config

Path (mode `0600`):

- macOS: `~/Library/Application Support/ScribeTab/config.json`
- Linux: `$XDG_DATA_HOME/ScribeTab/config.json` (default `~/.local/share/ScribeTab/config.json`)
- Windows: `%APPDATA%\ScribeTab\config.json`

Fields (toggles **off** by default): `obsidianEnabled`, `obsidianVaultPath?`, `notionEnabled`, `notion?: { token, parentPageId }`.

```
scribetab-host config get
scribetab-host config get obsidianVaultPath
scribetab-host config set obsidianEnabled true
scribetab-host config set notion.token secret
```

`config get` with no key redacts `notion.token`. The token is sent only to `https://api.notion.com`.

## Decisions

1. **Host-side config, not extension storage.** Simpler than a new native-messaging config channel; options page documents the CLI and config paths.
2. **Integrations never fail the meetings-dir write.** `HostSyncAck.ok` stays true; Obsidian/Notion problems join `ack.error` (same pattern as skipped audio).
3. **Obsidian idempotency via YAML `sessionId`.** Re-sync overwrites that file (keeps the original filename if the title changes), matching meetings-dir sessionId replace.
4. **Notion re-sync creates a new page.** The official API has no simple “replace this page’s body” equivalent to a file overwrite; each enabled sync calls `pages.create`. Paragraphs are chunked at 2000 chars; children beyond 100 go to `blocks.children.append`. 401/404 are not retried; 429 honors `Retry-After` (capped).
5. **NotebookLM is a download.** Pure function in `@scribetab/shared`, wired to the existing `chrome.downloads` path as format `notebooklm`.
6. **Summary on sync.** The extension now sends locked `sync_begin.summaryMarkdown` when the IndexedDB row has one, so Obsidian/Notion can include it. Finalize still does not wait on the LLM, so the first sync may land before the summary exists.

## Manual path

1. `pnpm --filter scribetab-host build` then `npx scribetab-host install`
2. `scribetab-host config set obsidianEnabled true` + vault path; optionally Notion token + parent page
3. Record → stop → files under `~/ScribeTab/meetings/` and, if enabled, `<vault>/ScribeTab/` and a Notion child page
4. Library → **Export for NotebookLM** → upload the `.md` in NotebookLM
