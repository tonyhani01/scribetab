# ScribeTab Implementation Roadmap

**Spec:** `docs/superpowers/specs/2026-08-26-scribetab-design.md`

This roadmap decomposes the approved spec into 9 phases. Each phase ships working,
testable software. Phases 1–2 have a detailed plan
(`2026-08-26-phase-1-2-scaffold-and-capture.md`); each subsequent phase gets its own
detailed plan (same format) written when the phase starts, arguing from this roadmap
and the spec.

## Locked interface contracts

These types are created in Phase 1 (`packages/shared/src/types.ts`) and every later
phase consumes them verbatim. Changing them requires updating this roadmap.

```ts
export interface MeetingSession {
  id: string;                // crypto.randomUUID()
  title: string;
  startedAt: string;         // ISO 8601
  endedAt?: string;
  platform: 'meet' | 'teams' | 'zoom' | 'youtube' | 'other';
  tabUrl?: string;
  status: 'recording' | 'complete' | 'failed';
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  startMs: number;           // ms since session start — ALWAYS session-relative,
  endMs: number;             // never chunk-relative; producers must add chunk offsets
  text: string;
  speaker?: string;          // from caption fusion (Phase 6)
  source: 'audio' | 'captions';
}

export interface TranscribeRequest {
  audio: ArrayBuffer;        // encoded audio (WAV in v1)
  mimeType: string;          // 'audio/wav'
  language?: string;         // BCP-47 hint
}

export interface TranscribeResult {
  text: string;
  segments?: { startMs: number; endMs: number; text: string }[];
  costUsd?: number;          // provider-computed estimate, feeds cost meter
}

export interface TranscriptionProvider {
  readonly id: string;       // 'openai' | 'groq' | 'deepgram' | 'mistral' | 'openrouter' | 'google' | 'custom'
  transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;          // set for 'custom' → localhost servers = local models
  model?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(messages: ChatMessage[], cfg: ProviderConfig): Promise<string>;
}
```

Native-host sync protocol (Phase 5), sent over a `chrome.runtime.connectNative()`
port. Chrome's limits are 4 GB extension→host and 1 MB host→extension per
message, but a whole meeting's audio must never travel as one giant JSON
message (memory/parse spike on both sides) — audio streams as bounded chunks:

```ts
export type HostSyncMessage =
  | {
      type: 'sync_begin';
      protocolVersion: 1;
      session: MeetingSession;
      segments: TranscriptSegment[];
      summaryMarkdown?: string;
      audio?: { format: 'wav'; sampleRate: number; totalChunks: number }; // present only when retention enabled
    }
  | { type: 'sync_audio_chunk'; sessionId: string; index: number; wavBase64: string } // ≤ 8 MiB decoded per chunk
  | { type: 'sync_end'; sessionId: string };

export interface HostSyncAck {
  ok: boolean;
  sessionId: string;
  error?: string;            // host replies after sync_end (and on any failure)
}
```

The host writes audio chunks to a temp file as they arrive and atomically
renames the session directory into place on `sync_end` — a killed sync never
leaves a half-written meeting visible.

## Phases

### Phase 1 — Scaffold  ✅ detailed plan exists
pnpm monorepo, `packages/shared` (types, WAV encoder, chunker — all TDD),
WXT + Preact extension shell with MV3 permissions, GitHub Actions CI.

### Phase 2 — Capture engine  ✅ detailed plan exists
`tabCapture.getMediaStreamId` from one click → offscreen document → Web Audio
re-route to speakers → AudioWorklet PCM → silence-aware chunker → WAV chunks in
IndexedDB → stop assembles a full recording the user can download and play.
**Milestone: record a tab, hear it while recording, play back the saved file.**

### Phase 3 — Transcription
- Implement `TranscriptionProvider` adapters in `packages/shared/src/providers/`:
  `openai.ts`, `groq.ts`, `deepgram.ts`, `mistral.ts`, `custom.ts` (OpenAI-compatible
  `baseUrl` — this is the local-model path: whisper.cpp server, Speaches, LM Studio).
  Unit-tested with mocked `fetch` fixtures per provider.
- Host permissions: cloud providers and custom/localhost endpoints need
  `optional_host_permissions` — the options page requests the configured origin
  via `chrome.permissions.request` before first use (adapters stay unchanged,
  but the manifest/permission flow is real work, not "zero code").
- Transcription queue in offscreen doc: chunk → provider → `TranscriptSegment[]`,
  exponential backoff (1s/4s/16s, then mark gap segment `"[transcription failed]"`).
- Options page: provider picker, key entry (stored `chrome.storage.local`), model,
  language, custom base URL. Keys masked in UI.
- Side panel (`chrome.sidePanel`): live transcript rendering segments as they arrive.
- Optional mic mixing: `getUserMedia({ audio: { echoCancellation: true } })` merged
  into the offscreen Web Audio graph; mic denied → tab-only capture, surfaced in UI,
  never an error state.
**Milestone: live transcript of a YouTube video in the side panel via any configured provider, including a localhost whisper server.**

### Phase 4 — Storage, search, export  ✅ implemented
- IndexedDB schema (`sessions`, `segments`, `audioChunks` object stores) behind a
  `SessionStore` module; retention toggle deletes `audioChunks` on finalize.
- MiniSearch full-text index over segments; search UI in side panel "Library" view.
- Exporters in `packages/shared/src/export/`: `markdown.ts`, `json.ts`, `srt.ts`,
  `vtt.ts` — pure functions `(session, segments) => string`, fully unit-tested.
- Storage quota guard: warn at 80% of `navigator.storage.estimate()`, auto-cleanup
  policy for old audio.
**Milestone: browse past meetings, search them, export any meeting in 4 formats.**

### Phase 5 — Native host + MCP  ✅ implemented
- Prerequisite: `@scribetab/shared` gains a build step (ESM + `.d.ts` to `dist/`
  with a proper `exports` map) so plain Node can import it — WXT bundles TS
  source, Node does not. Tested from both consumers.
- `apps/native-host`: Node ≥ 20, zero heavy deps. Two entrypoints, one codebase:
  `scribetab-host` (native messaging: length-prefixed JSON over stdio, receives
  the `HostSyncMessage` stream, writes `~/ScribeTab/meetings/<date>-<slug>/{transcript.md,transcript.json,summary.md,audio.wav}`)
  and `scribetab-mcp` (MCP stdio server; tools `list_transcripts`, `get_transcript`,
  `get_latest_transcript`, `search_transcripts`, `export_transcript` reading the same
  directory).
- Install script (`npx scribetab-host install`) writes the Chrome
  `NativeMessagingHosts` manifest for macOS/Linux/Windows. `allowed_origins`
  needs a stable extension ID: ship a packed `key` in the manifest for
  development and document the store ID once published.
- File layout rules: `~/ScribeTab/meetings/<date>-<slug>/` where slug is
  filesystem-sanitized (`[a-z0-9-]`, max 60 chars) with `-2`, `-3` suffixes on
  collision; sessions are written to a temp dir and atomically renamed in.
- Extension: sync-on-finalize + "sync all" button; graceful "host not installed" state.
- Tests: spawn host as child process, drive both protocols over stdio.
**Milestone: finish a meeting → files appear in `~/ScribeTab/` → Claude reads them via MCP.**

### Phase 6 — Speakers (caption fusion)  ✅ implemented
- Content script on `meet.google.com`: MutationObserver on the captions container,
  emits `{speaker, text, timestamp}` caption events (selectors isolated in one module
  with a fallback chain — Meet DOM churns).
- Fusion in `packages/shared/src/fusion.ts`: align caption timeline with audio
  segments by timestamp overlap; attach `speaker` to segments. Unit-tested against
  recorded caption/segment fixtures.
- Captions-only mode: transcription with zero API cost when captions are on.
**Milestone: Meet transcript with correct speaker names, no diarization model.**

### Phase 7 — Intelligence  ✅ implemented
- `LlmProvider` adapters (`openai-chat.ts`, `custom-chat.ts` — Ollama via baseUrl).
- Summary + action-items prompts on finalize; results in `summary.md` and side panel.
- PII redaction (`packages/shared/src/redact.ts`): regex pass (emails, phones, cards,
  SSNs) + user-defined terms, applied to text before LLM calls and before storage
  when enabled. Docs state plainly that raw audio sent to STT cannot be pre-redacted.
- Cost meter: per-provider rate table, accumulates `costUsd` per session.
**Milestone: meeting ends → summary, action items, and total cost, optionally fully local via Ollama.**

### Phase 8 — Integrations  ✅ implemented
- Obsidian: configurable vault path; native host copies markdown into it on sync.
- Notion: user token → official API (`pages.create` into a chosen parent); runs in
  native host, off by default.
- NotebookLM: no public API — "Export for NotebookLM" produces upload-ready .md/.txt.
**Milestone: transcript lands in an Obsidian vault and a Notion page.**

### Phase 9 — Polish & ship  ✅ implemented
- Consent reminder (optional banner), meeting auto-detect badge, hotkey audit,
  options UX pass, empty/error states.
- Playwright e2e suite green; README, per-app docs, CONTRIBUTING, screenshots.
- Web Store packaging: privacy disclosures, permission justifications, listing copy.
**Milestone: v1.0.0 tagged, store-submittable zip, reproducible build.**

## Deferred to v2 (explicitly out of scope for v1)
In-browser WebGPU models (transformers.js/Moonshine), true streaming STT
(Deepgram live WebSocket), Firefox build, translation.
