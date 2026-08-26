# MoA audit — Phase 1–2 implementation (2026-08-27)

**Code:** `main` @ `3106dac`  
**Also reviewed:** design spec + roadmap (locked contracts).  
**Verdict: revise, then ship the capture milestone.** Previous plan blockers (M1–M10) are actually fixed in the code. Remaining bugs can still lose audio or lie about success.

## Reviewers

| Slot | Model | How | Artifact |
|---|---|---|---|
| A | Hermes / Grok 4.6 | this session | `/tmp/scribetab-impl-review-hermes.md` |
| B | OpenAI gpt-5.6-sol | Codex CLI, subscription OAuth, read-only | `/tmp/scribetab-impl-review-codex-sol.md` |
| C | Kimi K3 | Hermes CLI via OpenRouter `moonshotai/kimi-k3` | `/tmp/scribetab-impl-review-kimi-k3.md` |

All three said **revise**. Shared tests (8) and extension typecheck are green. Extension test script is still `echo`.

## How this was triaged

- **Must-fix:** 2+ reviewers and independently checkable in the source.
- **Should-fix:** 2+ reviewers or one strong reviewer plus source evidence. Same branch if cheap.
- **Deferred:** real, but Phase 3–5 or a product call. Not this branch.
- **Rejected:** contradicted by code or Chrome docs.

---

## Already fixed vs the 2026-08-26 plan audit

Confirmed in the implementation by all three:

- Targeted `target` envelopes; foreign listeners return `false`.
- `getContexts` instead of `hasDocument`; offscreen created before `getMediaStreamId`.
- Offscreen never calls `chrome.storage`.
- Sample rate stored per chunk; assemble concatenates PCM + one header.
- Serialized writes with sync index assignment.
- State machine + refuse double start + wipe only after `getUserMedia` (still too early — see M2).
- `HostSyncMessage` is begin/chunk/end, not one giant Base64 WAV.

---

## Must-fix (this branch)

### M1. `writeChain.catch` swallows IDB failures
**Sources:** A, B, C  
**Evidence:** `offscreen/main.ts` 31–34, 104.  
**Runtime:** quota/abort → stop ACKs ok, download is missing audio.  
**Patch:** keep `writeError`; finalize / stop ACK fail if any `putChunk` failed.

### M2. `clearChunks()` still runs before the engine is proven
**Sources:** A, B, C  
**Evidence:** `offscreen/main.ts` 49–60, 85–89. Wipe is after `getUserMedia`, before `addModule` / node.  
**Runtime:** worklet 404 or AudioContext failure deletes the last good recording.  
**Patch:** wipe only after ctx is running, worklet loaded, and graph connected.

### M3. Orphaned live capture after a late start failure
**Sources:** A, B, C  
**Evidence:** `background.ts` 55–66. Offscreen start can succeed; later `storage.set` or catch path sets idle without `OFFSCREEN_STOP`. Offscreen then throws “already running” on the next Start.  
**Patch:** if offscreen started, compensate with awaited STOP. `handleStop` must not mark idle unless stop succeeded or the offscreen document is gone.

### M4. Concurrent `finalize()` returns before the first one finishes
**Sources:** B (blocker), A/C (same race via tab-removed + track-ended)  
**Evidence:** `offscreen/main.ts` 94–96 sets `finalized` and clears `engine` then returns for later callers. `background.ts` 140–141 sets idle without waiting.  
**Runtime:** download or a new start can race the last write.  
**Patch:** one `finalizePromise`; every caller awaits it. Background goes idle only after that ACK.

### M5. AudioContext is never resumed or state-checked
**Sources:** A, C (B omitted)  
**Evidence:** `offscreen/main.ts` 55–57.  
**Runtime:** suspended context → audible? maybe not; worklet never runs; UI says recording; chunks stay 0. Cheap to fix.  
**Patch:** `await ctx.resume()`; fail start if not `running`. Hook `processorerror`.

---

## Should-fix (same branch, cheap)

| ID | Finding | Sources | Patch |
|---|---|---|---|
| S1 | Same-tab navigation never finalizes | A, C | `tabs.onUpdated` on `capturedTabId` |
| S2 | Blob URL never revoked | A, B, C | revoke after `downloads.download` |
| S3 | IDB `tx.onabort` can hang | B | reject on abort |
| S4 | Assemble trusts unchecked rows | A, B, C | validate rate, header size, even PCM |
| S5 | `ensureOffscreen` has no create mutex | A, C | `creating` promise + AlreadyExists |
| S6 | Query active tab after awaits | B | snapshot tab id before `ensureOffscreen` |
| S7 | No assemble unit tests | A, B, C | pure `assembleWavChunks` + tests |
| S8 | First worklet frames dropped while `finalized` | C | arm handler only after `finalized = false` |

---

## Deferred (not this branch)

| Item | Why |
|---|---|
| One-click vs two-click popup | Product call. Spec still says one gesture. Keep popup for stop/download; do not rip it out here. |
| `chrome.commands` hotkey | Spec lists it. Separate UX commit. |
| Session-keyed IDB / Phase 4 schema | Real. Needs a versioned migration, not a drive-by. |
| Streamed / OPFS assemble (Codex memory spike) | Hours-long meetings. Architecture change. |
| Playwright capture e2e | Spec wants it; Phase 3 already deferred it. |
| `@scribetab/shared` `dist` build | Phase 5 Node host. |
| `unlimitedStorage` | Privacy/store justification. Ask before adding. |
| Native Base64 chunk overhead | Phase 5. |

---

## Rejected

- **Kimi `ProviderConfig.apiKey` redaction.** File bytes are `apiKey: string;`.
- **Codex “rewrite / 691 MB is a ship blocker.”** Duplicate memory is real for 1h+ meetings. Phase 2 milestone is a ~90s YouTube clip. Defer streaming assemble.
- **Worklet must connect to destination or it never runs.** Historical Chrome bug. Source already connects to destination; we will also connect the node as a cheap keep-alive, not treat it as proven-dead.

---

## Disagreements

| Topic | A | B | C | Decision |
|---|---|---|---|---|
| Verdict | revise | revise | revise | **revise** |
| Suspended AudioContext | high | not listed | blocker | **must-fix (M5)** |
| Finalize join race | high (orphan/stop) | blocker | high (nav) | **must-fix (M4)** |
| Assemble memory spike | medium | blocker | not listed | **defer** |
| Two-click | high | not listed | medium / conscious | **defer product** |

---

## This branch acceptance

A later pass is done when:

1. [x] Failed `putChunk` fails stop / finalize. No silent success.
2. [x] `clearChunks` runs only after the capture graph is live.
3. [x] Start catch stops a live offscreen engine.
4. [x] Concurrent finalize joins one promise.
5. [x] Context is resumed; start fails if not running.
6. [x] Same-tab navigation finalizes.
7. [x] Assemble validates rows; unit tests cover empty / one / two / mixed-rate.
8. [x] Branch is not merged to `main`.
