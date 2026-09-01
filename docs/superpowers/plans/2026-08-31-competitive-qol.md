# Competitive QoL & Feature Parity Implementation Plan

> **For agentic workers:** Each task section below is a self-contained brief. Implementers see only their own task plus the Global Constraints. Follow TDD: write the failing test first, run it, implement, run again, then stop (the orchestrator commits).

**Goal:** Implement the Phase A–D recommendations and quality-of-life items from `docs/research/2026-08-30-competitive-analysis-otter-readai-tactiq.md` — playback, chat, templates, editing, tags, import, vocabulary, chapters/talk-time, calendar, Zoom/Teams captions, host automations, and ~10 small QoL improvements.

**Architecture:** Chrome MV3 extension (WXT + Preact) in `apps/extension`, shared logic in `packages/shared`, Node native host in `apps/native-host`. No backend; all data local (IndexedDB + `~/ScribeTab/meetings`). LLM/STT via user-configured BYOK providers.

**Spec:** `docs/research/2026-08-30-competitive-analysis-otter-readai-tactiq.md` §3–§5.

**Execution:** pi agents on `openrouter/qwen/qwen3.8-flash`, dispatched wave-by-wave on branch `feature/competitive-qol`; orchestrator verifies diffs + runs `pnpm -r typecheck && pnpm -r test` after each task and commits. Adversarial review: codex CLI (`-m gpt-5.6-sol`) + Fable before merge to main.

## Global Constraints (prepended to every task brief)

- Repo: `/Users/tonyhani/Desktop/scribetab`, branch `feature/competitive-qol`. pnpm monorepo; TypeScript strict everywhere.
- UI is **Preact** (`preact`, hooks from `preact/hooks`), NOT React. JSX uses `class=`, not `className`. Follow existing component style in `apps/extension/entrypoints/sidepanel/*.tsx` (plain elements + `st-*` CSS classes + theme tokens like `--st-tint`; no new CSS frameworks).
- Privacy invariants (NON-NEGOTIABLE): no telemetry, no new network endpoints except ones the user explicitly configures; API keys only in `chrome.storage.local`; nothing leaves the machine except configured STT/LLM calls and existing host-side Notion.
- No new Chrome permissions except where a task explicitly says so.
- Settings live in `apps/extension/utils/settings.ts` (`Settings` interface + `DEFAULT_SETTINGS` + `normalizeSettings` — every new field needs a normalize guard so corrupted storage can't break the extension).
- Messages between contexts are typed unions in `apps/extension/utils/messages.ts`; add new variants there, never ad-hoc `chrome.runtime.sendMessage` shapes.
- Session persistence: `apps/extension/utils/sessionStore.ts` (`StoredSession`), segments in `segmentStore.ts`, audio chunks in `chunkStore.ts`, highlights in `highlightStore.ts`. All IndexedDB via `db.ts`.
- Tests: vitest. Extension tests in `apps/extension/test/`, shared in `packages/shared/test` (or alongside existing patterns — mimic neighbors). Run scoped: `pnpm --filter @scribetab/extension test`, `pnpm --filter @scribetab/shared test`, `pnpm --filter scribetab-host test`. Typecheck: `pnpm -r typecheck`.
- Do NOT run `git commit`, `git push`, or modify files outside the task's file list (reading anything is fine). Do not reformat unrelated code.
- LLM calls go through `packages/shared/src/llm/` providers with the untrusted-transcript framing (`DATA_FRAMING` in `summarize.ts`); transcripts are DATA, never instructions.
- When done, print: `SUMMARY:` + ≤10 lines (files changed, tests added, test command results). Do not paste file contents.

---

## Wave A — Phase A (playback, archive, notifications, pause)

### Task A1: Audio playback in the library

**Files:** Create `apps/extension/utils/playback.ts`, `apps/extension/test/playback.test.ts`. Modify `apps/extension/entrypoints/sidepanel/LibraryView.tsx`.

**What:** In the open-session view, render an audio player when the session has stored chunks: `<audio>` element fed by a Blob URL assembled from `chunkStore` rows; Play/Pause button, speed selector (1×/1.25×/1.5×/2×), current time / duration. Clicking a segment's timestamp seeks to `segment.startMs`; the segment containing `currentTime` gets class `st-segment--playing`. Keyboard (only while session open, not typing in an input): `Escape` play/pause, `ArrowLeft/ArrowRight` ±5 s.

**Interfaces:** `playback.ts` exports `assembleSessionAudio(sessionId: string): Promise<{ url: string; mimeType: string } | null>` (null when no chunks) and `revokeSessionAudio(url: string): void`. Chunk rows (`chunkStore.ts` `ChunkRow`) store either WAV chunks (concatenate: strip 44-byte header of chunks 1..n, patch RIFF sizes — reuse `packages/shared/src/wav.ts` helpers) or Opus/OGG chunks (see `apps/extension/utils/opusEncode.ts` + `packages/shared/src/ogg.ts`; for OGG, one Blob per session may already be a single stream of appended pages — inspect how `popup/main.tsx` "Download recording" builds its file and reuse that exact logic by extracting it into `playback.ts`, then point the popup download at the shared function too).

**Tests:** unit-test WAV concatenation (two tiny synthetic WAV chunks → one valid header, correct byte length) and null when no chunks. jsdom: no real audio playback needed.

**Acceptance:** typecheck + extension tests pass; popup download still works (its test suite stays green).

### Task A4: Pause / resume recording

**Files:** Modify `apps/extension/entrypoints/offscreen/main.ts`, `apps/extension/entrypoints/background.ts`, `apps/extension/utils/messages.ts`, `apps/extension/entrypoints/popup/main.tsx`, `apps/extension/entrypoints/sidepanel/LiveView.tsx`. Create `apps/extension/test/pause.test.ts` if a pure helper emerges; otherwise extend existing background/offscreen tests.

**What:** Add capture state `'paused'` alongside existing `'idle' | 'recording' | 'stopping'` (find the source of truth in `background.ts` / `chrome.storage.local` capture state). New messages `{target:'background', type:'PAUSE_CAPTURE'}` / `RESUME_CAPTURE`, forwarded to offscreen as `OFFSCREEN_PAUSE`/`OFFSCREEN_RESUME`. In offscreen: on pause, stop feeding PCM to the chunker (gate flag checked where worklet samples are consumed — audio graph and tab playback keep running; cut the current chunk via the chunker's existing flush/cut so no audio is lost); on resume, unset the gate. Paused time is excluded from segment timestamps only if trivial — otherwise keep wall-clock timestamps (acceptable; note it in code comment). Popup + LiveView get a Pause/Resume button between Start and Stop; elapsed timer shows "Paused". Badge text `⏸` while paused (see `actionBadge.ts`).

**Constraints:** consent banner logic untouched; `stopping` drain path untouched; a stop while paused must still finalize correctly.

**Acceptance:** typecheck + extension tests pass; new state round-trips through the existing capture-state storage without breaking `failStaleRecordings`.

### Task A2: Archive before delete

**Files:** Modify `apps/extension/utils/sessionStore.ts`, `apps/extension/utils/messages.ts`, `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/sidepanel/LibraryView.tsx`. Create `apps/extension/test/archive.test.ts`.

**What:** `StoredSession.archivedAt?: number`. New background messages `ARCHIVE_SESSION {sessionId}` and `RESTORE_SESSION {sessionId}` (mirror `RENAME_SESSION` handler pattern, including the sessionMutationQueue serialization). Library list hides archived sessions; a collapsed "Archived (n)" section at the bottom lists them with Restore buttons. The open-session Delete button becomes "Archive"; inside the Archived section, "Delete forever" does the old hard delete (keep `data-testid="delete-session"` on the hard delete). On background startup, purge sessions with `archivedAt` older than 30 days (call the existing full delete path so chunks/segments/highlights go too).

**Tests:** archive sets `archivedAt`; restore clears it; purge deletes only >30-day-old archived sessions.

**Acceptance:** typecheck + extension tests (including existing delete-button e2e/unit references) pass.

### Task A3: "Ready" notifications

**Files:** Modify `apps/extension/wxt.config.ts` (add `notifications` permission), `apps/extension/entrypoints/background.ts`, `apps/extension/utils/intelligence.ts`, `apps/extension/utils/settings.ts` (+ options page toggle in `apps/extension/entrypoints/options/main.tsx`). Create `apps/extension/test/notify.test.ts` with a pure helper if logic warrants.

**What:** Setting `notifyOnReady: boolean` (default `true`). When a session finalizes (transcription drain complete) → `chrome.notifications.create` "ScribeTab — transcript ready: <title>". When the summary lands (intelligence success path in `intelligence.ts`) → "Summary ready: <title>". Guard: only when `notifyOnReady` and the API exists (`chrome.notifications?.create` — tests run in jsdom without it). Use the 128px icon. No notification for captions-only zero-segment sessions.

**Acceptance:** typecheck + tests pass; manifest gains exactly one new permission.

---

## Wave B — Phase B (templates, chat, library-wide ask)

### Task B1: Summary templates + personal context

**Files:** Modify `apps/extension/utils/settings.ts`, `apps/extension/entrypoints/options/main.tsx`, `packages/shared/src/summarize.ts`, `apps/extension/utils/intelligence.ts`, `apps/extension/entrypoints/sidepanel/LibraryView.tsx` (template picker next to "Regenerate summary"). Create `packages/shared/test` additions beside existing `summarize` tests.

**What:** Replace the single `summaryPrompt` string with named templates while staying backward compatible: new settings fields `summaryTemplates: {id: string; name: string; guidance: string}[]` and `activeTemplateId: string` (`''` = default guidance); `normalizeSettings` migrates a non-empty legacy `summaryPrompt` into a template named "Custom" and selects it. Ship 5 built-in templates as constants in `packages/shared/src/summarize.ts` (exported `BUILTIN_TEMPLATES`): Standup, 1:1, Sales discovery, Lecture/Video, Interview — each 3–6 lines of guidance focusing the existing structured-summary JSON contract (do NOT change the output schema or `DATA_FRAMING`). Also add `personalContext: {name: string; role: string; team: string; outputLanguage: string}` (all `''` default) injected as one fixed system-prompt line when any field is set ("The user is <name>, <role> on <team>. Write outputs in <language>."). Options page: template dropdown + editable guidance textarea (editing a builtin forks it into a custom copy), personal-context fieldset. Library: small `<select>` of templates + Regenerate uses the chosen one for that run (message `REGENERATE_SUMMARY` gains optional `templateId`).

**Tests:** prompt assembly includes chosen template guidance + personal-context line; legacy `summaryPrompt` migration; schema/framing unchanged.

### Task B2: Chat with a transcript (live + open session)

**Files:** Create `packages/shared/src/chat.ts`, `packages/shared/test/chat.test.ts` (mimic sibling test locations), `apps/extension/entrypoints/sidepanel/ChatView.tsx`. Modify `packages/shared/src/index.ts` (export), `apps/extension/utils/messages.ts`, `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/sidepanel/main.tsx` (+ LiveView/LibraryView mount points: an "Ask" tab in live view and in the open-session view).

**What:** `chat.ts` exports `buildChatMessages(opts: { segments: TranscriptSegment[]; question: string; history: {q: string; a: string}[]; personalContext?: string }): ChatMessage[]` — system prompt: role + `DATA_FRAMING` reuse (import from `summarize.ts`) + "Answer only from the transcript; cite moments as [mm:ss]; say so when the answer isn't in the transcript." Transcript clipped head+tail like `SUMMARY_TRANSCRIPT_CHAR_LIMIT` does. Background handler `CHAT_ASK {sessionId, question, history}` → loads segments (redaction applied the same way `intelligence.ts` does), calls the configured LLM provider (reuse the provider/permission plumbing from `intelligence.ts` — same `needs-permission` behavior), responds `{ok, answer?, error?}`. ChatView: chips **Catch me up · What was decided? · Open questions · Draft a follow-up email** + free-text input; renders Q/A list; works during recording (segments so far) and on an open library session; chat history in-memory per session only (not persisted).

**Tests:** `buildChatMessages` framing/clipping/citation instruction; no persistence.

### Task B3: Ask across the library

**Files:** Create `apps/extension/utils/libraryAsk.ts`, `apps/extension/test/libraryAsk.test.ts`. Modify `apps/extension/entrypoints/sidepanel/LibraryView.tsx` (an "Ask your meetings" box above search), `apps/extension/utils/messages.ts`, `apps/extension/entrypoints/background.ts`.

**What:** `libraryAsk.ts` exports `selectContext(hits: {sessionId: string; segments: TranscriptSegment[]; title: string; startedAt: number}[], budgetChars: number): {header: string; body: string}[]` — takes MiniSearch results (reuse `searchCache`/`search.ts` the way LibraryView's search already does: query the index with the user's question, take top 8 sessions, pull matching segments ±2 neighbors), formats blocks headed `## <title> (<date>) [session <n>]`, truncating to a ~24k-char budget. Background `LIBRARY_ASK {question}` handler builds blocks, then calls `buildChatMessages` (from Task B2 — import `@scribetab/shared`) with the blocks as the "transcript" and an adjusted instruction: cite as `[<title> mm:ss]`. UI: input + answer area + "sources" list of session titles that were included; clicking a source opens that session.

**Tests:** `selectContext` respects budget, orders by search score, includes neighbor segments.

---

## Wave C — Phase C (editing, tags, import, vocabulary)

### Task C1: Transcript editing

**Files:** Modify `apps/extension/utils/segmentStore.ts`, `apps/extension/utils/messages.ts`, `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/sidepanel/LibraryView.tsx`. Create `apps/extension/test/editSegment.test.ts`.

**What:** `segmentStore` gains `updateSegmentText(sessionId: string, segmentId: string, text: string): Promise<void>` (find how segments are keyed first; follow the store's existing patterns). Background message `EDIT_SEGMENT {sessionId, segmentId, text}` through the sessionMutationQueue; empty/whitespace text rejected. LibraryView open-session transcript rows get a pencil `st-icon-btn` → `window.prompt` prefilled with current text (matching the existing rename UX) → on save, update store, update the searchCache (`applySegmentsUpdated` exists — see LibraryView's `SEGMENTS_UPDATED` handling) and re-render. Edited segments flow into exports automatically (exports read the store). Set a `editedAt` timestamp on the session row.

**Tests:** update round-trip; rejection of empty text; search index refresh hook called.

### Task C2: Typed highlight tags

**Files:** Modify `packages/shared/src/types.ts` (`HighlightMoment` gains `kind?: 'highlight' | 'action' | 'decision' | 'question' | 'note'`, default `'highlight'`), `apps/extension/utils/highlightStore.ts`, `apps/extension/utils/messages.ts` (`ADD_HIGHLIGHT` gains optional `kind`), `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/sidepanel/LiveView.tsx` (four small buttons: ⭐ ✅ 🔴 ❓ replacing the single Highlight button, same disabled logic), `apps/extension/entrypoints/sidepanel/LibraryView.tsx` (filter chips per kind above the highlights list), and wherever highlights render in exports (`highlightsWithContext` / markdown exporters in `packages/shared`) — prefix with the kind emoji.

**Tests:** extend existing highlight tests: kind persisted, default backfilled for old rows, export line contains emoji.

### Task C3: Import transcript files (VTT / SRT / TXT / JSON)

**Files:** Create `packages/shared/src/importTranscript.ts`, tests beside shared tests. Modify `packages/shared/src/index.ts`, `apps/extension/entrypoints/sidepanel/LibraryView.tsx`, `apps/extension/utils/messages.ts`, `apps/extension/entrypoints/background.ts`.

**What:** `importTranscript.ts` exports `parseTranscriptFile(name: string, content: string): {title: string; segments: Omit<TranscriptSegment, 'id'|'sessionId'>[]} | {error: string}`. VTT/SRT: cues → segments (`startMs`/`endMs` from cue times, speaker from `<v Name>` or `Name:` prefixes when present). TXT: split paragraphs, no timestamps (`startMs` = index*1000 fallback), `Name:` prefix → speaker. JSON: accept ScribeTab's own `transcript.json` shape (inspect `apps/native-host/src/sessionWriter.ts` for the exact shape). Library toolbar "Import" button → `<input type=file accept=".vtt,.srt,.txt,.json">` → read text → background `IMPORT_TRANSCRIPT {name, content}` → create an already-finalized session (source `'import'`, no audio) + segments; open it. Audio/video file import is explicitly OUT OF SCOPE (documented follow-up).

**Tests:** golden parse tests for each format incl. a malformed-file error case.

### Task C4: Custom vocabulary

**Files:** Create `packages/shared/src/vocab.ts` + test. Modify `apps/extension/utils/settings.ts` (`vocabTerms: string[]`, default `[]`), `apps/extension/entrypoints/options/main.tsx` (textarea, one term per line, with optional `wrong=>right` pairs), STT provider adapters `packages/shared/src/providers/{openai,groq,mistral,openaiCompatible}.ts` (pass terms joined as the Whisper `prompt` form field when non-empty) and `deepgram.ts` (append `keyterm=<term>` query params), plus the ingest path where segments are stored (where redaction runs — apply after redaction).

**What:** `vocab.ts` exports `parseVocab(lines: string[]): {hints: string[]; replacements: [string, string][]}` and `applyReplacements(text: string, replacements: [string, string][]): string` (word-boundary, case-preserving-first-letter). Hints go to providers that support them; replacements always applied at ingest.

**Tests:** parse `wrong=>right`; boundary-safe replacement; provider request includes prompt/keyterm (extend existing provider tests — see how `providerProbe`/adapter tests build requests).

---

## Wave D — Phase D (chapters/talk-time, Zoom/Teams captions, calendar, automations)

### Task D1: Chapters + talk-time

**Files:** Modify `packages/shared/src/types.ts` (`SessionSummary` gains `chapters?: {title: string; startMs: number}[]`), `packages/shared/src/summarize.ts` (JSON contract asks for `chapters` using segment timestamps; parser tolerant — missing → `[]`; `summaryToMarkdown` renders a "Chapters" section as `- mm:ss Title`). Create `packages/shared/src/talkTime.ts` + test: `computeTalkTime(segments: TranscriptSegment[]): {speaker: string; ms: number; pct: number}[]` (segment duration = endMs−startMs, unknown speaker → "Unknown"). Modify `apps/extension/entrypoints/sidepanel/SummaryView.tsx`: chapters list (click seeks playback if the A1 player is mounted — emit a CustomEvent `st-seek` with `startMs`; A1's player listens... if A1's player exists, else no-op) and a horizontal talk-time bar (plain divs, `st-*` classes, percentages labeled).

**Tests:** talkTime math; chapters parse fallback; markdown render.

### Task D2: Zoom web + Teams web caption speakers (best-effort)

**Files:** Create `apps/extension/entrypoints/zoom-captions.content.ts`, `apps/extension/entrypoints/teams-captions.content.ts`, `apps/extension/utils/zoomSelectors.ts`, `apps/extension/utils/teamsSelectors.ts` (+ tests for the pure reduce/parse helpers). Modify `apps/extension/utils/captionGate.ts` / `captionSession.ts` / `background.ts` only as needed to accept caption events from the new hosts (the Meet pipeline `CAPTION_EVENT` is platform-agnostic — reuse it).

**What:** Mirror `meet-captions.content.ts` structure: MutationObserver on the captions container, reduce DOM rows to `{speaker, text}` cues, emit the same `CAPTION_EVENT`. Selectors (documented as fragile, keep in the selectors module with a comment header): Zoom web client captions container `[aria-label="Live Transcription"], .live-transcription-subtitle__item` (speaker `.live-transcription-subtitle__name`, else "Speaker"); Teams web `[data-tid="closed-caption-renderer"], [data-tid="closed-captions-renderer"]` rows `[data-tid="closed-caption-message"]` with author `[data-tid="author"]`. Guard everything: if containers never appear, do nothing (no errors in console spam — one debug log max). Content-script matches: `https://*.zoom.us/wc/*`, `https://app.zoom.us/wc/*`, `https://teams.microsoft.com/*`, `https://teams.live.com/*`. NOTE: manifest content-script matches for these hosts are NEW host exposure but content scripts don't need host permissions beyond matches — keep `run_at: document_idle`, no site data access beyond captions.

**Tests:** pure cue-reduce functions with synthetic DOM-ish fixtures (strings/objects, not real DOM where possible; follow how `captionReduce.ts` is tested for Meet).

### Task D3: Native-host calendar (.ics) → auto-title + next-meeting

**Files:** Create `apps/native-host/src/ics.ts` + `apps/native-host/test/ics.test.ts` (match host test layout). Modify `apps/native-host/src/config.ts` (`icsUrl?: string`), `apps/native-host/src/protocol.ts` + `packages/shared/src/types.ts` (new request `{type:'get_upcoming', protocolVersion}` → ack `{ok, events: {title: string; startMs: number; endMs: number}[]}` — next 12 h only), `apps/native-host/src/host.ts` (handler: fetch `icsUrl` with 5 s timeout, parse, cache 5 min; on any failure return `{ok: true, events: []}`), `apps/extension/utils/nativeSync.ts` (helper `getUpcomingEvents()`), `apps/extension/entrypoints/background.ts` (at capture start, if a fetched event overlaps now ±5 min, use its title as the session title when the tab is a known meeting URL), `apps/extension/entrypoints/popup/main.tsx` ("Next: <title> at <time>" line when idle and events exist).

**What:** `ics.ts` exports `parseIcs(text: string, now: Date): {title, startMs, endMs}[]` — minimal parser: unfold folded lines, VEVENT blocks, DTSTART/DTEND (UTC `Z`, `TZID` treated as local, all-day skipped), SUMMARY unescaping; ignore RRULE beyond: if RRULE present, skip (documented limitation). Network: `icsUrl` is user-configured, host-side only, off by default — matches the Notion precedent in `PRIVACY.md` wording; add one line to `apps/native-host/README.md` config table.

**Tests:** parse fixture with folding, TZID, escaped commas; window filter; RRULE skipped.

### Task D4: Host automations (rule-based routing)

**Files:** Create `apps/native-host/src/automations.ts` + test. Modify `apps/native-host/src/config.ts` (`automations?: {titleContains?: string; destination: 'obsidian' | 'notion'; subfolder?: string}[]`), `apps/native-host/src/integrations.ts` (after a session sync: evaluate rules against the session title; matching rules route the markdown copy — obsidian rules may set a vault subfolder; notion rules force page create even when the global `notionEnabled` toggle is off IF the rule exists — no, simpler and safer: rules only ROUTE/FILTER what the enabled integrations already do: an obsidian rule with `subfolder` writes there instead of the vault root; if any automations exist and none match, integrations still run as today).

**What:** `automations.ts` exports `matchAutomations(rules: Rule[], title: string): Rule[]` (case-insensitive substring) — pure. `integrations.ts` consumes it; subfolder path is sanitized (no `..`, created if missing). Config via existing `scribetab-host config set` (document JSON example in host README).

**Tests:** matching, sanitization, no-rules = unchanged behavior.

---

## Wave E — QoL batch

### Task E1: Export & copy options

**Files:** Modify `apps/extension/utils/exportDownload.ts`, `packages/shared/src/…` markdown exporter (find `exportMarkdown`), `apps/extension/entrypoints/sidepanel/LibraryView.tsx`. Tests beside existing export tests.

**What:** Export options object `{timestamps: boolean; speakers: boolean; combineSameSpeaker: boolean}` (defaults true/true/false) threaded into `exportMarkdown` (and copy). Three checkboxes in a small row above the export chips + a "Copy transcript" chip using `navigator.clipboard.writeText`. `combineSameSpeaker` merges consecutive same-speaker segments into one paragraph (timestamp = first).

### Task E2: Labels + auto-label rules

**Files:** Modify `apps/extension/utils/sessionStore.ts` (`labels?: string[]`), create `apps/extension/utils/autoLabel.ts` + test, modify `apps/extension/entrypoints/background.ts` (label at finalize), `apps/extension/entrypoints/sidepanel/LibraryView.tsx` (label chips on cards + filter row).

**What:** `autoLabel.ts` exports `computeLabels(input: {title: string; durationMs: number; speakerCount: number; url?: string}): string[]` — system labels: `1:1` (exactly 2 speakers), `Long` (>60 min), `YouTube` (url host youtube.com), `Meet`/`Zoom`/`Teams` by url. Filter: clicking a label chip in the library filters the list; no custom rules UI in v1 (settings-free).

### Task E3: Private notes while recording

**Files:** Modify `apps/extension/entrypoints/sidepanel/LiveView.tsx`, reuse Task C2's `kind: 'note'`: a one-line input + Add button that sends `ADD_HIGHLIGHT {kind:'note', label: text}`. Notes render in the transcript flow (highlights already interleave via `highlightsWithContext`) and export with 📝 prefix. Test: note kind flows through (extend highlight tests).

### Task E4: Save Meet chat messages

**Files:** Modify `apps/extension/entrypoints/meet-captions.content.ts` (or a small new observer module `apps/extension/utils/meetChat.ts` + test for the pure part), `apps/extension/utils/settings.ts` (`saveMeetChat: boolean`, default false, options toggle), background: chat lines become segments with `speaker: '<name> (chat)'` at wall-clock offset. Selector best-effort: Meet chat panel `[aria-live="polite"]` message groups; guard failures silently.

### Task E5: Theme preference

**Files:** Modify `apps/extension/utils/settings.ts` (`theme: 'system' | 'light' | 'dark'`, default `'system'`), options page radio, and the entry css/root of sidepanel/popup/options: current styling uses `prefers-color-scheme` tokens — add `data-theme="light|dark"` on `<html>` overriding token blocks (`:root[data-theme='dark'] { … }` mirroring the media-query block; find where `--st-*` tokens are defined). Apply on load + `chrome.storage.onChanged`.

### Task E6: Library card cost/model + popup onboarding card

**Files:** Modify `apps/extension/entrypoints/sidepanel/LibraryView.tsx` (session cards show `~$0.0123 · groq/whisper-large-v3-turbo` when the session has cost/provider metadata — check `costMeter.ts` / session fields for what's stored; add fields at finalize in background if missing), `apps/extension/entrypoints/popup/main.tsx` (when no STT provider configured: a small card "1 · Choose a provider → 2 · Test connection → 3 · Record this tab" with the Open settings button).

### Task E7: Speaker merge on rename collision

**Files:** Modify `apps/extension/utils/speakerRename.ts` (+ its test), `apps/extension/entrypoints/sidepanel/LibraryView.tsx`.

**What:** Renaming speaker X to an existing display name Y currently creates a duplicate name; make it a merge: `confirm("Merge X into Y?")` → both map to Y (segments keep original keys; the `speakerNames` map points both at Y; distinctSpeakers dedupes by display name — verify `packages/shared/src/speakers.ts` handles it and adjust there if needed).

---

## Wave F — Docs & polish (orchestrator or single agent)

### Task F1: README + store listing + PRIVACY updates

Update `README.md` feature list, `docs/store-listing.md` (notifications permission justification; new content-script hosts for Zoom/Teams captions; import; chat), `PRIVACY.md` (chat/library-ask sends transcript text to the configured LLM origin only; .ics fetch host-side, off by default). One agent task at the end, orchestrator-verified against the actually-merged features.

---

## Verification protocol (orchestrator)

Per task: `git diff --stat` review → scoped tests → full `pnpm -r typecheck` → commit `feat(scope): …`. Per wave: full `pnpm -r test`. End: adversarial review (codex `-m gpt-5.6-sol` + Fable read of full branch diff), fix findings, then merge `feature/competitive-qol` → `main`, push.

## Risk register

- D2 selectors are guesses against live products — best-effort, guarded, may need manual follow-up.
- A1 OGG/Opus concatenation depends on how chunks were encoded; the popup download path is the source of truth.
- Audio-file import deliberately out of scope (documented).
- qwen3.8-flash quality: every task gets orchestrator diff review; escalation ladder: retry w/ feedback → codex → orchestrator inline.
