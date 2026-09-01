# ScribeTab

Open-source, BYOK-first AI meeting transcriber. Captures audio straight from
browser tabs (Google Meet, Teams web, Zoom web, YouTube) — one click, no
screen-share picker, no bot in your call. Capture, transcripts, and keys stay
on this machine unless you opt into a network path: the STT/LLM provider *you*
configure (cloud key or localhost), and optional Notion page create from the
native host (`api.notion.com`). Transcripts are exposed to AI agents and
notetaking apps via MCP.

**Status: v1.2.0.** Capture, live transcription, library/search/export, native
host + MCP, Meet caption speakers, summaries, and Obsidian/Notion/NotebookLM
integrations are implemented.

Requirements: Chrome ≥ 116, Node ≥ 20, macOS/Linux/Windows

License: GPL-3.0-only

## Features

- Tab audio capture with optional mic mix (echo-cancelled)
- Live transcript in the side panel via OpenAI, Groq, Deepgram, Mistral,
  OpenRouter, Google Gemini, or a custom OpenAI-compatible server
  (whisper.cpp, Speaches, LM Studio)
- Captions-only mode on Google Meet, Zoom (web client), and Microsoft Teams
  (zero STT cost), with optional Meet chat capture
- Audio playback in the library with segment seeking, plus pause/resume while
  recording
- Library search, Markdown/JSON/SRT/VTT export with configurable options,
  NotebookLM-ready Markdown, and transcript import (VTT/SRT/TXT/JSON)
- Chat with a transcript (live or from the library) and "Ask your meetings"
  across the whole library — answers come only from your configured LLM
- Summary templates (Standup, 1:1, Sales discovery, Lecture, Interview) with
  personal context, chapters, and talk-time stats
- Manual speaker renaming (with merge on collision) and typed highlight
  moments — ⭐ highlight, ✅ action, 🔴 decision, ❓ question, 📝 private notes
  (Alt+Shift+H)
- Transcript segment editing, custom vocabulary, auto-labels (1:1, Long,
  Meet/Zoom/Teams/YouTube), and archive with 30-day purge
- Desktop notifications when transcripts and summaries are ready (optional)
- Calendar-aware session naming via .ics feeds and host-side automations
- Light/dark/system theme
- Configurable audio retention (7 days, 30 days, or until storage runs low)
- Optional summaries and action items (OpenAI or local Ollama)
- PII redaction on text (not on audio sent to STT)
- In-Meet consent toast, elapsed recording timer, and side-panel recording controls
- Native host sync to `~/ScribeTab/meetings/` plus MCP tools
- Optional Obsidian vault copy and Notion page create (host-side, off by default)
- Consent reminder, meeting-tab badge (`REC?`), and capture hotkeys

## Install the extension (unpacked)

1. `pnpm install`
2. `pnpm --filter @scribetab/extension build`
3. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
   `apps/extension/.output/chrome-mv3`
4. Development ID (packed `key` in `apps/extension/wxt.config.ts`):
   `cambjpbepplcihlihagiheggdkfcpmef`

Store-submittable zip: `pnpm --filter @scribetab/extension zip` →
`apps/extension/.output/scribetab-<version>-chrome.zip` (exact name is printed by
the command). Listing copy and permission justifications:
[`docs/store-listing.md`](docs/store-listing.md).

Product screenshots:

| View | Screenshot |
| --- | --- |
| Popup | [popup.png](docs/screenshots/popup.png) |
| Side panel — live | [sidepanel-live.png](docs/screenshots/sidepanel-live.png) |
| Side panel — library | [sidepanel-library.png](docs/screenshots/sidepanel-library.png) |
| Options | [options-full.png](docs/screenshots/options-full.png) |

## Provider setup

Open the extension options page. Keys are stored only in `chrome.storage.local`
and are sent only to the origin you grant.

| Kind | Provider | Notes |
| --- | --- | --- |
| STT | openai / groq / mistral | OpenAI-compatible `audio/transcriptions` |
| STT | openrouter | OpenAI-compatible `audio/transcriptions`; default `openai/whisper-large-v3` |
| STT | google | Gemini 3.5 Transcribe (`gemini-3.5-transcribe`, public preview) via Interactions API |
| STT | elevenlabs | Scribe v2 (`scribe_v2`) via `POST /v1/speech-to-text`, diarized word timestamps |
| STT | deepgram | `POST /v1/listen` |
| STT | custom | Set base URL, e.g. `http://localhost:8080/v1` |
| LLM | openai | Summaries on finalize |
| LLM | custom | Ollama / LM Studio, e.g. `http://localhost:11434/v1` |

Chrome will prompt for host permission for that origin on Save or **Test
connection**. Cloud providers need an API key; localhost servers usually do not.

### Local whisper (example)

Run any OpenAI-compatible transcription server, then in options:

- Provider: `custom`
- Base URL: `http://localhost:8080/v1` (match your server)
- Model: whatever the server expects (`whisper-1` is a common default)

## Native host

Writes meetings to `~/ScribeTab/meetings/<date>-<slug>/`.

```
pnpm --filter scribetab-host build
node apps/native-host/dist/host.bin.js install
```

The default manifest allows both the development ID and the Chrome Web Store ID;
use `--extension-id <id>` only for a different custom build. npm publish
is planned; until then install from a clone. Details:
[`apps/native-host/README.md`](apps/native-host/README.md).

Obsidian / Notion (off by default):

```
scribetab-host config set obsidianEnabled true
scribetab-host config set obsidianVaultPath /path/to/vault
scribetab-host config set notionEnabled true
scribetab-host config set notion.token -
scribetab-host config set notion.parentPageId PAGE_ID
```

## MCP usage

The same host package exposes `scribetab-mcp` (stdio) over `~/ScribeTab/meetings/`.

Tools: `list_transcripts`, `get_transcript`, `get_latest_transcript`,
`search_transcripts`, `export_transcript`.

Any MCP client on this machine can read every saved transcript — grant access only to agents you trust.

Point your MCP client at the `scribetab-mcp` binary from
`apps/native-host/dist/mcp.bin.js` after `pnpm --filter scribetab-host build`.

## Hotkeys

Suggested defaults (Chrome may ignore them on conflict — rebind at
`chrome://extensions/shortcuts`):

| Command | Default |
| --- | --- |
| Start recording the active tab | Alt+Shift+R |
| Stop recording | Alt+Shift+S |
| Open the transcript side panel | Alt+Shift+T |
| Add a highlight moment | Alt+Shift+H |

## Packages

| Path | Role |
| --- | --- |
| [`apps/extension`](apps/extension/README.md) | MV3 extension (WXT + Preact) |
| [`apps/native-host`](apps/native-host/README.md) | Native messaging + MCP |
| [`packages/shared`](packages/shared/README.md) | Locked types, providers, export, fusion |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for pnpm, tests, and branch flow.
Design and roadmap live in `docs/superpowers/`.
