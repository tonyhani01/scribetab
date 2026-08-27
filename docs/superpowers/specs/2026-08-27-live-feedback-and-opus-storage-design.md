# Live feedback UX + compressed audio storage — design

Date: 2026-08-27
Status: awaiting owner sign-off
Owner feedback driving this:

1. "I dont like the feedback at all. Chunking transcripts is not good at all, generating
   summary being a static text gives the feeling its stuck. Its also very slow."
2. "I think storage will be an issue, is there a way to store the audio in another format
   thats smaller to save?"

Two separable deliverables, one session. Deliverable A ships without B and vice versa.

---

## Current state (measured from code)

- Capture runs at the device sample rate — `new AudioContext()` in
  `apps/extension/entrypoints/offscreen/main.ts` — typically **48 kHz**, not 16 kHz.
  The context must stay at native rate: tab audio is routed to `ctx.destination` so the
  user keeps hearing the meeting; a 16 kHz context would degrade playback.
- `SilenceChunker` cuts at **targetSeconds 45 / maxSeconds 60**. First transcript text
  therefore lands ~50–65 s after speech starts (chunk fill + upload + provider), and then
  arrives in ~1-minute bursts. This is the "chunky and slow" feel.
- `TranscriptionQueue` is one-chunk-in-flight FIFO with retries (1 s/4 s/16 s). Sidepanel
  gets `SEGMENTS_ADDED` per finished chunk; there is no "in progress" affordance at all.
- Storage: 16-bit mono PCM WAV per chunk in IndexedDB.
  **48 kHz → 5.76 MB/min → ~345 MB/hour.** Quota enforcement kicks in at 80% and deletes
  oldest sessions' audio down to 70%.
- Transcription **does not read chunkStore** — `enqueueChunk` hands the in-memory WAV
  straight to the queue. Storage format and STT wire format are fully decoupled today.
- Summary: `summarizeMeeting` = two sequential non-streaming `chat/completions` calls.
  UI is a static "Generating summary…" (`intelligence === 'pending'`), plus the
  persisted `intelligenceError` banner (recent fix — must not regress).
- Native host protocol v1: `sync_begin.audio = { format: 'wav', sampleRate, totalChunks }`;
  host strips the 44-byte header per chunk and back-patches one WAV header.
- Popup "Download recording (.wav)" concatenates stored WAV chunks.
- Meet captions-only mode stores no audio — untouched by all of this.

---

## Deliverable A — transcription & summary feedback UX

### A1. Smaller chunks (the actual latency fix)

Change `SilenceChunker` parameters at the offscreen call site:
`targetSeconds 45 → 12`, `maxSeconds 60 → 20`. Silence-alignment logic unchanged.

Effect: first text at ~15 s instead of ~1 min; steady drip of segments every ~12–15 s.

Trade-offs (the provider/latency call the owner should sign off on):

| | today (45/60) | proposed (12/20) |
|---|---|---|
| first text visible | ~50–65 s | ~14–20 s |
| requests per hour | ~70 | ~250 |
| Groq 10 s minimum billing | fine | fine (chunks ≥ 12 s) |
| per-second billers (OpenAI, Deepgram, Mistral) | — | same cost, more requests |
| rate limits / flaky-network exposure | lower | higher (mitigated by existing retry queue) |
| STT accuracy at boundaries | — | slightly more cuts, still silence-aligned |

Cost stays essentially flat for every built-in provider (all bill per audio second;
Groq's 10 s floor is cleared). The real cost is request count — acceptable, and the
retry queue already handles transient failures per chunk.

Rejected alternatives:
- **Provider streaming (Deepgram live WS, OpenAI Realtime)**: true real-time, but a new
  per-provider surface that only some providers have → inconsistent UX and a much bigger
  change. Worth a future phase, not this one. Smaller chunks get 80% of the win generically.
- **Overlapping "preview" transcription of the partial chunk**: pays for the same audio
  twice. Rejected.

### A2. Pending transcription rows (kills the "stuck" feel between chunks)

New ephemeral message from offscreen → sidepanel when a chunk is cut and enters the
queue: `CHUNK_TRANSCRIBING { sessionId, index, startMs, durationMs }`. The existing
`SEGMENTS_ADDED` resolves it: it gains a `chunkIndex` field and the sidepanel retires
the pending row with the matching index (see A4).

Sidepanel renders a pending row in the transcript list at its timestamp: shimmer bar +
"Transcribing…" using theme tokens (`--st-tint` shimmer on `--st-track`, respects
light/dark, `prefers-reduced-motion` → static "Transcribing…" text). Pending rows are
in-memory only; a reopened panel simply doesn't show them (storage remains the source of
truth), which matches existing behavior.

While `captureState === 'recording'` the list footer shows a live status line instead of
silence: "Listening…" (audio accumulating, no chunk in queue) or "Transcribing X of Y" —
honest progress from A3.

### A3. Honest progress counters

Background already tracks `chunkCount` (saved chunks). Add `transcribedCount` mirrored to
`chrome.storage.local` from the existing `SEGMENT_SAVED`/`CHUNK_SAVED` flow — but count
**chunks completed by the queue** (success or failure-marker), not segments, so X of Y is
truthful. Offscreen reports it via a new `chunkIndex` field on the existing
`SEGMENT_SAVED` notify (every queue job ends in exactly one `onSegments` call, including
the failure marker, so this is a complete signal).

Surfacing:
- Popup: "Saved chunks N" row becomes "Transcribed X / Y chunks" while recording.
- Sidepanel live view: footer status line (A2).
- During stop (`stopping` state, queue draining): "Finishing transcription… X / Y".

### A4. Message plumbing

`ToSidePanel` gains `CHUNK_TRANSCRIBING` (above). `SEGMENTS_ADDED` gains optional
`chunkIndex?: number` so the sidepanel can retire exactly the matching pending row.
All fields optional/additive — no migration.

### A5. Summary generation feedback

Three layers, all building on the existing `intelligence`/`intelligenceError` states:

1. **Animated indicator + elapsed time.** Persist `intelligenceStartedAt` (ms) on the
   session row when flipping to `'pending'`. Detail view replaces the static line with a
   pulsing dot (theme accent, reduced-motion-safe) + "Generating summary · 0:42".
   Elapsed keeps counting across panel reopen since the timestamp is persisted. If
   `intelligenceError` is set, the existing error banner renders instead (no regression).
2. **Streaming the summary text.** Add optional `stream(messages, cfg, onDelta)` to the
   OpenAI-compatible chat adapter (`stream: true`, SSE parse of `data:` lines). Both LLM
   providers (`openai`, `custom`) speak this dialect. `runFinalizeIntelligence` prefers
   `stream` when present, falls back to `complete` on stream setup failure. Deltas go
   sidepanel-ward as `SUMMARY_DELTA { sessionId, phase: 'summary' | 'actions', text }`
   runtime messages (ephemeral, best-effort — same pattern as `SEGMENTS_ADDED`).
   Sidepanel shows the accumulating markdown live in the summary card. Persistence is
   unchanged: only the final combined markdown is written; a crash mid-stream leaves
   `'pending'` and the retry path intact. Token cost estimation unchanged (estimate on
   the concatenated final text, exactly as today).
3. **Two-phase label.** Since summarize → action items are sequential calls, the
   indicator says "Generating summary…" then "Extracting action items…" (driven by
   `SUMMARY_DELTA.phase`, falling back to the generic label when no deltas arrive).

Non-goals: no summary-during-recording, no partial-summary persistence.

### A6. Tests

- vitest: chunker params (first-emit timing), pending-row reducer logic (add/retire on
  chunkIndex), transcribedCount accounting incl. failed chunks, SSE parser unit tests
  (delta assembly, malformed stream → fallback), `runFinalizeIntelligence` stream
  fallback + error persistence (extend `intelligence.test.ts`).
- Playwright e2e: recording shows pending shimmer row then real segment (mock provider
  with delay); summary card streams text; elapsed timer visible.

---

## Deliverable B — Opus audio storage

### B1. Approach (recommended): encode per-chunk Ogg Opus via WebCodecs; STT keeps WAV

The insight that makes this cheap: **STT never reads storage.** So we change only what
`putChunk` persists, not what providers receive — zero provider-compat risk, including
whisper.cpp/local servers and Gemini's inline-base64 path.

Per finished chunk in the offscreen document:

1. Downsample the Float32 chunk to **16 kHz** once (linear resampler in shared code —
   deterministic and unit-testable; speech content is fully preserved at 16 kHz and it's
   what STT models use internally anyway).
2. **STT payload**: `encodeWav(pcm16k, 16000)` — uploads shrink 3× (60 s: 5.76 MB →
   1.92 MB), which also speeds every provider round-trip and gives Gemini's 8 MiB
   inline-base64 limit huge headroom.
3. **Stored payload**: WebCodecs `AudioEncoder` (`codec: 'opus'`, 16 kHz mono,
   **32 kbps**) → packets muxed into a standalone **Ogg Opus** file per chunk by a small
   muxer in `packages/shared` (~200 lines: OpusHead/OpusTags + Ogg page framing + CRC).
   WebCodecs is available in the offscreen document (Chrome ≥ 94; our floor is 116).
   Encode failure → fall back to storing 16 kHz WAV for that session and surface nothing
   fatal (audio is never lost to a codec bug).

Numbers per hour of recording:

| format | size/hour | vs today |
|---|---|---|
| today: 48 kHz 16-bit WAV | ~345 MB | 1× |
| 16 kHz 16-bit WAV (fallback) | ~115 MB | 3× smaller |
| Ogg Opus 32 kbps mono | ~14 MB | ~24× smaller |
| Ogg Opus 24 kbps mono | ~11 MB | ~31× smaller |
| **Ogg Opus 16 kbps mono + DTX (proposed)** | **~4–7 MB** (DTX skips silence) | **~50–80× smaller** |

All variants enable DTX (discontinuous transmission — near-zero bytes during silence,
a 20–50% real-world saving on meeting audio) and default VBR; both are plain fields in
the WebCodecs Opus encoder config. 16 kbps is clearly intelligible speech; 24 kbps keeps
more tone/timbre; 32 kbps is transparent. Owner's call — default 16 kbps + DTX. A 1 GB
quota goes from ~3 h of retained audio to ~150–250 h.

Rejected alternatives:
- **MediaRecorder (`audio/webm;codecs=opus`)**: chunked `dataavailable` blobs are not
  independently decodable (headers only in the first blob), which breaks the per-chunk
  store/export/sync model; restarting the recorder per chunk drops samples at boundaries.
  WebCodecs gives exact control and testability.
- **Downsample-only (16 kHz WAV)**: trivial but only 3×. Kept as the automatic fallback
  path, so the code exists anyway.
- **Store compressed and feed compressed to STT**: possible (most providers accept ogg)
  but reintroduces per-provider compat risk (Gemini lists OGG *Vorbis*, not Opus;
  whisper.cpp servers often want WAV) for zero benefit — we already hold the PCM.

### B2. Schema & migration

`ChunkRow` gains `format?: 'wav' | 'ogg-opus'` (absent ⇒ `'wav'`) and
`durationMs?: number`. New sessions write one format throughout; existing WAV rows remain
readable forever. No data migration, no DB version bump needed beyond the type change
(verify in `db.migration.test.ts`).

### B3. Export / download

- Popup download: for `ogg-opus` sessions, demux the stored per-chunk Ogg files (our own
  muxer's output — we can parse it) and **remux packets into one continuous Ogg Opus
  stream** with running granule positions. No re-encode, fast, and the result is a single
  standard `.ogg` that Chrome/VLC/ffmpeg play. Button label becomes
  "Download recording (.ogg)"; legacy WAV sessions keep `.wav` behavior.
- `assembleRecording` returns `{ blob, seconds, ext: 'wav' | 'ogg' }`.

### B4. Native host sync

Bump to `protocolVersion: 2` (host accepts 1 and 2):
- `sync_begin.audio` becomes `{ format: 'wav', sampleRate, totalChunks }` **or**
  `{ format: 'ogg-opus', totalChunks }`.
- For `ogg-opus`, the extension remuxes to the single Ogg stream (same code as B3) and
  streams it in ≤ 8 MiB base64 slices; `sync_audio_chunk` field renamed use stays
  (`wavBase64` → keep name for v1, add `dataBase64` for v2 messages). Host appends bytes
  verbatim and writes `audio.ogg`; no header patching. WAV path unchanged.
- Old host + v2 message fails loudly ("Unsupported protocolVersion 2") — surfaced in the
  existing sync error banner with a "reinstall host" hint. Acceptable pre-publish; host
  and extension ship together in this repo.

### B5. Interactions with existing behavior

- `retainAudio: false` and captions-only: unchanged (nothing stored either way).
- Quota (`enforceQuota`): unchanged logic; pressure drops ~24×.
- `MAX_AUDIO_CHUNK` 8 MiB checks: now trivially satisfied (a 20 s opus chunk ≈ 80 KB).
- Cost meter, redaction, fusion: untouched (segment-side only).

### B6. Tests

- vitest (shared): resampler (known sine fixtures), Ogg muxer (page structure, CRC,
  granulepos, OpusHead fields), remux-to-single-stream (packet identity, monotonic
  granulepos), round-trip decode via `decodeAudioData` where the environment allows.
- vitest (extension): chunkStore format field, assemble ext selection, nativeSync v2
  message shapes; native-host: v2 dispatch, `audio.ogg` write, v1 regression.
- Playwright e2e: record → stored chunks are `ogg-opus` and ~25× smaller than the WAV
  equivalent; download produces a playable `.ogg` (decode it in-page and assert duration).

---

## Sequencing

1. **A1 + A3** (chunk size + counters) — smallest, immediately felt.
2. **A2** (pending rows) — UI layer on the same messages.
3. **A5** (summary streaming + elapsed) — independent of 1–2.
4. **B** behind its own branch: shared resampler+muxer first (pure TDD), then offscreen
   wiring, then export, then host protocol v2.

Each lands via the repo workflow: branch TDD, owner's manual Chrome checklist, merge.
Nothing is pushed to any remote without being asked.

## Open questions for owner sign-off

1. Chunk cadence 12/20 s ok, or prefer a middle ground (e.g. 20/30) to keep request
   volume lower? (Cost is flat either way; it's request count vs. latency.)
2. Opus bitrate: 16 kbps + DTX (recommended, ~4–7 MB/h) or 24 kbps + DTX (~7–9 MB/h) if
   re-listen fidelity matters more than size?
3. Download for opus sessions as `.ogg` acceptable? (Alternative — decode to WAV on
   export — recreates the 345 MB file; not recommended.)
4. Native host protocol v2 with loud failure on stale hosts acceptable pre-publish?
5. Deepgram/OpenAI *streaming* STT explicitly deferred to a future phase — agreed?
