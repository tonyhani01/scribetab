# MoA audit — 2026-08-26-phase-1-2-scaffold-and-capture

**Plan:** `docs/superpowers/plans/2026-08-26-phase-1-2-scaffold-and-capture.md`  
**Also reviewed:** design spec + roadmap (locked contracts).  
**Date:** 2026-08-26  
**Verdict: not validated for implementation.** Revise Tasks 5–6 and two locked contracts first. Do not copy-paste the plan as written.

## Reviewers

| Slot | Model | How | Artifact |
|---|---|---|---|
| A | Hermes / Grok 4.6 | this session, adversarial | `/tmp/scribetab-review-hermes.md` |
| B | OpenAI gpt-5.6-sol | Codex CLI (`codex exec -m gpt-5.6-sol`, subscription OAuth, read-only) | `/tmp/scribetab-review-codex-sol.md` |
| C | Kimi K3 | Hermes CLI via OpenRouter `moonshotai/kimi-k3` | `/tmp/scribetab-review-kimi-k3.md` |

First Kimi run died on OpenRouter idle timeout while emitting a huge `write_file`. Second run (compact brief, file tools only) wrote the artifact. Codex verdict was "rewrite"; Hermes and Kimi said "revise". Triage: **revise**. The product shape is right. The copy-pasteable capture protocol is not.

## How this was triaged

- **Must-fix:** 2+ reviewers, and independently checkable against Chrome docs or the plan text.
- **Should-fix:** 2+ reviewers or one strong reviewer plus plan evidence. Same revision, not a later phase.
- **Rejected:** contradicted by file bytes or official API docs.
- Child summaries were treated as claims, not facts. Native-messaging limits, `hasDocument` availability, tabCapture stream-id lifetime, and offscreen API surface were checked against Chrome docs. `ProviderConfig.apiKey` was hex-dumped from the roadmap file.

---

## Must-fix before any implementation

These will break the Phase 2 milestone or lock a contract you cannot keep.

### M1. Broadcast messaging has two listeners and the wrong one can answer
**Sources:** A, B, C  
**Evidence:** Phase plan Task 5 listener (751–757) always `sendResponse({ ok: true })`. Background (604–621) `return true`s for every message, including `ASSEMBLE_WAV`, then never responds. Popup broadcasts (859–866).  
**Runtime:** first `sendResponse` wins. Offscreen can ACK `START_CAPTURE` without capturing. Background can leave the assemble port hanging so download fails.  
**Patch:** destination + request id on every envelope. One authoritative responder per request. Unknown types must not `return true`. Popup talks only to the service worker; SW forwards to offscreen.

### M2. Task 6 does not typecheck
**Sources:** A, B, C  
**Evidence:** listener stays typed `BackgroundToOffscreen` (`OFFSCREEN_START | OFFSCREEN_STOP`, 579–581, 751). Task 6 adds `msg.type === 'ASSEMBLE_WAV'` (804) without widening the union. Plan self-review claims "placeholders: none" and "type consistency" (971–974). That is false.  
**Runtime:** `pnpm typecheck` in Task 7 is red.  
**Patch:** one inbound union for the offscreen endpoint. Replace the listener as a whole.

### M3. Assembled WAV uses 48000 after a normal stop
**Sources:** A, B, C  
**Evidence:** `stop()` nulls `ctx` (743–749). Assemble uses `ctx?.sampleRate ?? 48000` (814).  
**Runtime:** 44.1 kHz capture plays fast and sharp. This is the Phase 2 milestone ("play back the saved file").  
**Patch:** persist `sampleRate` on every IDB row / session record. Parse WAV headers. Never guess.

### M4. Stream id is taken before the offscreen consumer exists
**Sources:** A, B, C  
**Evidence:** `getMediaStreamId` then `ensureOffscreen` then send (610–612). Chrome: stream ids are one-use and expire in a few seconds. Official sample creates the offscreen document first.  
**Runtime:** cold start / slow `createDocument` → `getUserMedia` rejects after a valid gesture.  
**Patch:** create and load offscreen first, then get the id, then consume immediately.

### M5. No write barrier; chunk indexes can reorder
**Sources:** A, B, C (Kimi was the most precise)  
**Evidence:** live chunks are `void saveChunk(...)` (739). `chunkIndex++` happens after `await openDb()` (690–699). Stop only awaits the flush remainder (743–745). Assemble sorts by `index` (813).  
**Runtime:** two overlapping saves can swap indexes. Immediate download can miss in-flight chunks. Worklet can emit after `flush()`.  
**Patch:** assign the index synchronously before any await. Serialize writes on a promise chain. Stop: disconnect input, stop accepting port messages, drain the chain, then ACK.

### M6. Tab close / navigate never finalizes
**Sources:** A, B, C  
**Evidence:** spec error handling (design 85) says tab closed or navigated finalizes gracefully. Tasks 5–6 have no `tabs.onRemoved`, no track `ended`, no `AudioContext` state watch.  
**Runtime:** stream dies, UI stays `recording`, remainder never flushed.  
**Patch:** one idempotent finalize path shared by user stop, track ended, tab gone, context error.

### M7. `chrome.offscreen.hasDocument()` is Chrome 150+, floor is 116
**Sources:** A, B (C underweighted this)  
**Evidence:** `ensureOffscreen()` calls `hasDocument()` (593). Constraint and manifest say Chrome 116 (plan 20, 485). Current Chrome offscreen reference: `hasDocument` is Chrome 150+.  
**Runtime:** Chrome 116–149 throws on first start.  
**Patch:** `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` plus a create mutex. Or raise the floor and say so.

### M8. Offscreen calls `chrome.storage.local`
**Sources:** A, B (C listed as a verify/low)  
**Evidence:** `saveChunk` does `chrome.storage.local.set({ chunkCount })` (698). Offscreen docs: only `chrome.runtime` is exposed.  
**Runtime:** IDB write can succeed, then storage throws. `void saveChunk(...)` swallows it. Popup counter stays 0. On stop the awaited flush can fail before tracks close.  
**Patch:** offscreen posts `{ type: 'CHUNK_SAVED', count }` to the SW. SW owns `chrome.storage.local`. Teardown in `finally`.

### M9. Locked `SyncSessionMessage.audioWavBase64` cannot carry a real meeting
**Sources:** A, B, C  
**Evidence:** roadmap 70–79, 119–129. Chrome: extension → native host max 64 MiB; host → extension 1 MiB. 48 kHz 16-bit mono WAV + Base64 crosses 64 MiB in under ~9 minutes.  
**Runtime:** audio retention + sync fails for ordinary meetings. This is a locked contract, so Phase 1 must not paste it as-is.  
**Patch:** versioned begin/chunk/end over `connectNative()`, or have the host write a file without embedding the WAV in one JSON object. Update the roadmap lock in the same commit as the types file.

### M10. Capture is not a state machine
**Sources:** A, B, C  
**Evidence:** only `idle | recording` (569–584). `start()` always `clearChunks()` (711–713) before `getUserMedia` (715). No starting/stopping/failed, no session or tab ownership.  
**Runtime:** double start destroys a live recording and can leak tracks / AudioContexts. Failed start still wipes the previous file.  
**Patch:** serialized session-id state machine. Refuse START while recording. Clear IDB only after capture is actually granted.

---

## Should-fix in the same plan revision

| ID | Finding | Sources | Patch |
|---|---|---|---|
| S1 | `start()` has no rollback; `stop()` has no `finally` | A, B | Own every node/track. Rollback on failed `addModule` / resume / IDB. Deterministic teardown. |
| S2 | IDB schema is a throwaway (`{ keyPath: 'index' }`, wipe on start) while Phase 4 promises session stores | A, B | Lock the real schema now: `[sessionId, index]`, sampleRate, status, db version, migration tests. |
| S3 | Spec says one gesture; plan is open popup then Start | A, B | Wire `action.onClicked` / `commands`, or change the spec to two clicks. |
| S4 | `@scribetab/shared` has `main: src/index.ts` and no build. Phase 5 Node host cannot import it. | A, B | Emit ESM + `.d.ts` to `dist`. Declare `exports`. Test WXT and plain Node. |
| S5 | No host-permission / CORS design for custom or localhost STT | A, B | `optional_host_permissions` for the configured origin. Spec's "zero extra code" is false. |
| S6 | CI never tests capture. Extension test is `echo`. Chunker tests use 2s/4s @16 kHz, not 45/60 @ AudioContext rate. | A, B | Automated built-extension capture against known audio. Test production defaults separately. |
| S7 | Offscreen reason is only `USER_MEDIA` but the doc also plays audio and creates Blobs | A, B | Declare `USER_MEDIA`, `AUDIO_PLAYBACK`, `BLOBS`. Note `AUDIO_PLAYBACK` 30s idle lifetime. |
| S8 | Assemble is a full Float32 + re-encode memory spike | A, B | Concat little-endian PCM + one header. Do not expand to float. |
| S9 | Requantize loop (Int16 → float → Int16) is lossy and pointless | B | Same as S8. |
| S10 | Empty recording returns `{ ok: true }` and a 44-byte WAV | B | Reject zero chunks. |
| S11 | Worklet module path `/pcm-worklet.js` should be `chrome.runtime.getURL(...)` | A | Use the extension URL. |
| S12 | Spec CI includes lint; Task 7 CI does not | A, B | Add a linter now or stop claiming lint in the spec. |
| S13 | Locked `TranscriptSegment.startMs` is ambiguous (chunk vs session). Chunks store no offset. | A, B | Lock timing semantics before types freeze. |
| S14 | Native host `allowed_origins` needs a stable extension ID | B | Packed key / documented unpacked vs store IDs. |
| S15 | `~/ScribeTab/meetings/<date>-<slug>` has no collision, sanitization, or atomic finalize rules | B | Specify them in the roadmap now. |

---

## Rejected

### R1. Locked `ProviderConfig` is invalid TypeScript (`apiKey: ***`)
**Source:** C only.  
**Why rejected:** Hermes file tools redact `apiKey: string` to `apiKey: ***`. Hex of the roadmap file is `61 70 69 4b 65 79 3a 20 73 74 72 69 6e 67 3b` (`apiKey: string;`). Valid TS. Do not "fix" this.

### R2. Full product rewrite
**Source:** B verdict wording.  
**Why rejected:** Tasks 1–4 (monorepo, WAV TDD, chunker TDD, WXT scaffold) are salvageable. Rewrite the capture protocol and two locked contracts, not the whole plan.

---

## Disagreements (kept visible)

| Topic | A Hermes | B Codex Sol | C Kimi K3 | Decision |
|---|---|---|---|---|
| Overall | revise | rewrite | revise | **revise** |
| `hasDocument` vs 116 | blocker | blocker | low / "not the binding constraint" | **must-fix (M7)** |
| `chrome.storage` in offscreen | blocker | blocker | low / verify | **must-fix (M8)** |
| Native WAV envelope | blocker | blocker | medium | **must-fix (M9)** because it is locked in Phase 1 types |
| One-click vs two-click | high | high | not raised | **should-fix (S3)** |
| Shared package build | high | high | not raised | **should-fix (S4)** |
| chunkIndex after await | covered under write barrier | write barrier | explicit blocker | **must-fix (M5)** using Kimi's precise bug |
| ProviderConfig syntax | not a bug | not a bug | blocker | **rejected (R1)** |

---

## Spec / roadmap gaps the phase plan inherited

Keep these in the roadmap revision, even if Phase 1–2 does not implement them.

1. Redaction order contradicts itself. Data flow stores segments then redacts on stop. Next paragraph says redact before storage. Roadmap stores in Phase 4, redacts in Phase 7.
2. "Localhost models, zero extra code" ignores private-network access, CORS, and `optional_host_permissions`.
3. Privacy invariant 2 ("keys only in `chrome.storage.local`") will collide with a Notion token in the native host (Phase 8).
4. Locked session types omit schema version, sample rate, provider, failure, retention, retry.
5. Privacy / store work is dumped entirely into Phase 9. Meeting audio + keys need a privacy design now.
6. GPLv3 vs Chrome Web Store terms is unresolved. Decide sideload-only vs store before Phase 9 packaging.
7. Name check is weak. Exact "ScribeTab" may be free; Tab Scribe, TabScribe, and Scribely Tab Capture already exist.

---

## What all three agreed the plan got right

- SW `getMediaStreamId` → offscreen `getUserMedia` is the correct Chrome 116 tabCapture path.
- Explicit speaker reroute after tabCapture mute (`source.connect(ctx.destination)`).
- WAV encoder has real header and clamp tests.
- Silence chunker TDD, including a hard max so chunks cannot grow forever.
- Phase 1–2 stays local. No telemetry. No network client.

That is why this is a revise, not a kill.

---

## Required plan edits (acceptance for a re-audit)

A later pass is "validated" only if all of these are true in the plan text, not in a sidebar note:

1. [ ] Message protocol has destinations, one responder, no unconditional `return true`.
2. [ ] Offscreen inbound union includes `ASSEMBLE_WAV` before the branch is written.
3. [ ] Sample rate is stored with chunks. Assemble never defaults to 48000.
4. [ ] Offscreen exists and is loaded before `getMediaStreamId`.
5. [ ] Writes are serialized. Indexes assigned before any await. Stop drains the queue.
6. [ ] One finalize path for user stop, track ended, and tab gone.
7. [ ] Offscreen existence check is `getContexts` (or the Chrome floor is 150+).
8. [ ] Offscreen never calls `chrome.storage.*`.
9. [ ] `SyncSessionMessage` no longer embeds a full Base64 WAV. Roadmap lock updated.
10. [ ] Capture state machine refuses double start and does not wipe IDB until capture is live.
11. [ ] Self-review section no longer claims type consistency or "placeholders: none" unless those are actually true.

---

## Validation

| Question | Answer |
|---|---|
| Is the design direction sound? | Yes. |
| Is the Phase 1–2 plan implementable as written? | **No.** |
| Are locked contracts safe to freeze? | **No.** `audioWavBase64` must change. Timing semantics are incomplete. |
| Can an agent execute Tasks 5–6 by copy-paste? | **No.** Messaging, types, sample rate, stream-id order, and storage API are wrong. |
| Re-audit needed after the patch? | Yes. Same three-slot MoA, or at least one independent reviewer on the revised Tasks 5–6. |

Do not start coding until the must-fix list is in the plan.
