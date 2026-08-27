# scribetab-host

Node ≥ 20 native messaging host and MCP server for ScribeTab.

## Binaries

- `scribetab-host` — Chrome native messaging (length-prefixed JSON over stdio)
- `scribetab-mcp` — MCP stdio server over `~/ScribeTab/meetings/`

## Install (Chrome native messaging)

```
npx scribetab-host install
npx scribetab-host install --extension-id <id>
npx scribetab-host uninstall
```

Development extension ID (packed `key` in `apps/extension/wxt.config.ts`):

`cambjpbepplcihlihagiheggdkfcpmef`

`allowed_origins` is `chrome-extension://<id>/`. Replace with the Chrome Web Store ID once published.

Manifest locations (per-user):

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.scribetab.host.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.scribetab.host.json` |
| Windows | `%USERPROFILE%\ScribeTab\NativeMessagingHosts\com.scribetab.host.json` + `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.scribetab.host` |

## Layout

`~/ScribeTab/meetings/<YYYY-MM-DD>-<slug>/{transcript.md,transcript.json,summary.md?,audio.wav?}`

Slug is `[a-z0-9-]`, max 60 characters, with `-2`, `-3`, … on collision. Sessions are written to a hidden temp directory and renamed into place on `sync_end`.

## Host config (Obsidian / Notion)

All integrations are **off by default**. There is no interactive prompt — use:

```
scribetab-host config get
scribetab-host config get obsidianVaultPath
scribetab-host config set obsidianEnabled true
scribetab-host config set obsidianVaultPath /path/to/vault
scribetab-host config set notionEnabled true
scribetab-host config set notion.token -
scribetab-host config set notion.parentPageId PAGE_ID
```

`config set` takes a single value argument (quote it if it contains spaces). Values may start with `-`. The recommended way to set `notion.token` is `-`, which reads the token from stdin and avoids exposing it on the process command line. The argv form (`config set notion.token secret`) still works.

`obsidianVaultPath` must be an absolute path. Config writes are atomic (temp file + rename, mode `0600`) but are **not locked** against concurrent `config set` processes.

Config file (mode `0600`):

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/ScribeTab/config.json` |
| Linux | `$XDG_DATA_HOME/ScribeTab/config.json` (default `~/.local/share/ScribeTab/config.json`) |
| Windows | `%APPDATA%\ScribeTab\config.json` |

When enabled, a successful meetings-dir commit is acked immediately; Obsidian/Notion then run best-effort. Re-sync of a known Notion `sessionId` skips page creation (a partial append is archived and recreated). Integration status is written to `integrations.json` beside the meeting (and the Notion page-id map in the user data dir). Failures never fail the meetings-dir write or the core ack; they surface as a follow-up host message and in the side panel as a warning. `config get` with no key redacts `notion.token`.
