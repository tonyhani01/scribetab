# ScribeTab — Design Specification

**Date:** 2026-08-26
**Status:** Approved
**License:** GPLv3

## What ScribeTab is

An open-source, BYOK-first AI meeting transcriber built as a browser extension. It captures audio directly from browser tabs (Google Meet, Teams web, Zoom web, YouTube) with **one click, no screen-share picker, and no bot joining the call**. Everything is stored locally; the only network traffic is the API call to the transcription/LLM endpoint the user configured. Transcripts are exposed to AI agents and notetaking apps through MCP.

### Differentiators vs. prior art

Closest prior art is `hugoblanc/meet-transcriber` (MIT — GPLv3-compatible, may be studied/borrowed with attribution) and `danielsemerjya/tabscribe`. ScribeTab differs by: multi-provider BYOK (not OpenAI-only), first-class local model support, speaker attribution via caption fusion, notetaking integrations, and a richer MCP surface.

## Non-negotiable product contract (privacy invariants)

1. The only bytes that leave the machine are:
   - audio/text sent to the STT/LLM endpoint the user configured, and
   - optional pushes to Notion if the user connects it.
2. API keys live in `chrome.storage.local` — never `chrome.storage.sync`, never any server. Integration tokens used by the native host (e.g. Notion, Phase 8) live in the host's local config file with `0600` permissions — same rule, different local store.
3. Transcripts live in IndexedDB and local files under `~/ScribeTab/`. No telemetry, no analytics, no phone-home of any kind.
4. Capture starts only from an explicit user action on the extension — a button in the toolbar popup, or a hotkey. No auto-start (Chrome forbids it), no screen-picker dialog (`tabCapture.getMediaStreamId` avoids it), no meeting bot.

## Architecture

pnpm monorepo, TypeScript everywhere, no backend, no database server:

```
scribetab/
├── apps/extension/      WXT + Preact — Chrome/Edge first, Firefox later
├── apps/native-host/    Node — file store, MCP stdio server, integrations
├── packages/shared/     types, provider adapters, chunker, merge/redaction logic
├── docs/
└── LICENSE              GPLv3
```

### Extension components

| Component | Responsibility |
|---|---|
| Service worker | Orchestration: meeting-tab detection (URL patterns → badge), `chrome.commands` hotkey, start/stop lifecycle, session state |
| Offscreen document | Audio engine (MV3 service workers cannot hold media streams). `tabCapture.getMediaStreamId()` → Web Audio graph mixing tab + optional mic (echo-cancelled; falls back to tab-only if mic denied) → re-route tab audio to speakers (tabCapture mutes playback) → AudioWorklet emits PCM → chunker → transcription queue |
| Content scripts | Google Meet caption scraping (DOM captions + participant names → speaker timeline); optional consent-reminder banner |
| Side panel | Live transcript as chunks return, session controls, running cost meter |
| Options page | Providers/keys, model selection, audio retention, redaction rules, integrations, export |

### Chunker

Cuts ~45s segments on silence boundaries (RMS threshold) so sentences are not split mid-word. Chunks are encoded and queued; failed uploads retry with exponential backoff. A flaky network means "transcript arrives late," never "audio lost."

### Provider adapters (`packages/shared`)

Two interfaces, each implementation ~100 lines:

- `TranscriptionProvider`: OpenAI, Groq (whisper-large-v3-turbo), Deepgram, Mistral Voxtral, and **Custom OpenAI-compatible endpoint** — this last one is the local-model story: whisper.cpp server, Speaches/faster-whisper, LM Studio on `localhost` all use the same adapter code. Each configured endpoint (cloud or localhost) requires an `optional_host_permissions` grant, requested from the options page before first use.
- `LlmProvider` (summaries/action items): any OpenAI-compatible chat endpoint — Ollama gives fully-local summaries.

In-browser WebGPU transcription (transformers.js + Moonshine/distil-whisper) is deferred to v2.

### Data flow

Click → capture → chunks → near-real-time transcription → optional PII redaction at ingest → segments merged with caption-scraped speaker timeline (speaker attribution without a diarization model) → IndexedDB + live side panel → on stop: LLM summary + action items → sync via native messaging to `~/ScribeTab/meetings/<date>-<title>/` as `transcript.md`, `transcript.json`, `summary.md` (+ audio when retention is enabled).

**Redaction scope (honest):** when enabled, redaction applies to segment *text at ingest* — before the segment is stored, and therefore before any LLM call, export, or sync sees it. Audio sent to the STT provider cannot be pre-redacted, and raw audio retained on disk is unredacted; the docs must say both.

### Native host + MCP

One small Node process, dual role:

1. **Native messaging host** (registered by an install script) — receives finished sessions from the extension and writes the meeting files.
2. **MCP stdio server** (`scribetab-mcp`) — tools: `list_transcripts`, `get_transcript`, `get_latest_transcript`, `search_transcripts`, `export_transcript`. Any MCP client (Claude, agents) can query meetings and push notes onward.

### Integrations (all optional, all off by default)

- **Obsidian:** write markdown into a configured vault folder — fully local.
- **Notion:** user's own integration token → official API.
- **NotebookLM:** no public API exists; provide formatted export files instead.

## Feature list (v1)

Capture (tab + optional mic), near-real-time chunked transcription, live side panel, Meet caption scraping + speaker fusion, summaries + action items, cost meter, PII redaction (text), audio retention toggle, local full-text search (MiniSearch), exports (MD/JSON/SRT/VTT), MCP server + tools, Obsidian/Notion/NotebookLM integrations, meeting auto-detect badge, hotkey, consent reminder, no telemetry.

## Error handling

- Tab closed/navigated mid-meeting → session finalizes gracefully with captured audio.
- Service-worker suspension → capture state lives in offscreen doc + storage; immune.
- Provider errors → per-chunk retry with backoff, then a marked gap in the transcript rather than silent loss.
- Storage quota guard + configurable auto-cleanup of old audio.
- Mic permission denied → tab-only capture, surfaced in UI, never an error state.

## Testing

- **Vitest** unit tests for pure logic in `shared`: adapters (against recorded fixtures), chunker, speaker-merge, redaction, cost math.
- **Playwright** loading the built extension; e2e capture against a local test page playing known audio.
- **stdio harness** tests for the MCP server tools.
- **GitHub Actions** CI on every PR: typecheck, lint, unit, build.

## Decisions log

| Decision | Choice | Why |
|---|---|---|
| v1 scope | Extension + native host/MCP together | MCP is the core differentiator; host is small |
| Transcription timing | Near-real-time ~45s chunks | Works with every provider; degrades to batch; true streaming deferred |
| Local models | OpenAI-compatible localhost endpoints | Reuses BYOK adapter; zero extra code; WebGPU in-browser deferred to v2 |
| Speakers | Meet caption fusion, not diarization models | Free, accurate names, no model weight |
| UI framework | WXT + Preact | MV3 scaffolding + tiny bundle |
| Name | ScribeTab | Verified no product/repo/store collision (2026-08-26) |
| License | GPLv3 | User requirement; MIT prior art may be borrowed with attribution |
