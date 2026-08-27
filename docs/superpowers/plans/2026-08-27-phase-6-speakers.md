# Phase 6 — Speakers via caption fusion

**Date:** 2026-08-27
**Status:** Implemented
**Roadmap:** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md` Phase 6
**Branch:** `phase-6-speakers`

## Goal

Google Meet live captions yield speaker names. Those names are fused onto audio
transcript segments by timestamp overlap, or used as the transcript itself in
captions-only mode (zero STT provider calls).

Locked `TranscriptSegment` (`speaker?`, `source: 'audio' | 'captions'`) is consumed
verbatim. Exporters already render `speaker` when present; they were not changed.

## File map

### `packages/shared`

| File | Role |
|---|---|
| `src/fusion.ts` | `CaptionCue` + `fuseSpeakers(segments, captions)` — majority-overlap wins |
| `test/fusion.test.ts` | overlap, adjacent, gap, multi-speaker-in-one-segment, immutability |

### `apps/extension`

| File | Role |
|---|---|
| `utils/meetSelectors.ts` | Ordered selector fallbacks; `found` / `not_found` container state |
| `utils/captionReduce.ts` | Pure mutation → caption-event reducer (coalesce; emit on speaker change or stabilize) |
| `utils/captionTimeline.ts` | Wall-clock → session-relative ms |
| `utils/captionSession.ts` | In-memory cue timeline, captions-only segment builder, fuse helper |
| `entrypoints/meet-captions.content.ts` | `https://meet.google.com/*` MutationObserver content script |
| `utils/messages.ts` | `CAPTION_EVENT`, `SEGMENTS_UPDATED` |
| `utils/settings.ts` | `captionsOnly: boolean` (default `false`) |
| `entrypoints/background.ts` | Ingest captions; skip STT when captions-only; live + finalize fusion |
| `entrypoints/options/main.tsx` | Captions-only checkbox |
| `entrypoints/sidepanel/main.tsx` | Bold `Name:` prefix; merge `SEGMENTS_UPDATED` by id |
| `test/captionReduce.test.ts` | Coalesce / speaker-change / stabilize |
| `test/meetSelectors.test.ts` | Fallback chain + `not_found` |
| `test/captionTimeline.test.ts` / `captionSession.test.ts` | Session-relative cues |

## Decisions

1. **Selectors never inline.** All Meet DOM queries go through `meetSelectors.ts`.
   The content script only calls `findCaptionsContainer` / `parseCaptionNodes`.
2. **Captions-only disables STT for that capture**, even if a provider is saved.
   Audio is still recorded. Caption events become `TranscriptSegment` rows with
   `source: 'captions'` and session-relative timestamps.
3. **Fusion is majority overlap**, ties broken by earliest caption `startMs`.
   Adjacent (end === start) is not overlap. No overlap leaves `speaker` unchanged.
4. **Live fusion is cheap:** on each audio `SEGMENT_SAVED` and each caption event
   (non-captions-only), re-fuse IndexedDB segments and broadcast `SEGMENTS_UPDATED`.
   Finalize fuses once more before the timeline is dropped.
5. **Debounce 400ms** of unchanged caption text = stabilized. Speaker change or
   captions container disappearing flushes immediately.
6. **In-memory cue timeline** in the service worker, keyed by session id. SW death
   mid-meeting can drop unfused names until captions resume; segments remain.

## Selector fallback strategy

Meet's class names churn. Each role has an **ordered** list; the first match wins.

| Role | Chain (first → last) |
|---|---|
| Container | `[data-caption-window]`, `div[aria-label="Captions"]`, `div[aria-label="Live captions"]`, `div[aria-label="Captions displayed"]`, `div[jsname="dsyh5c"]`, `div[jsname="tgaKEf"]`, `.a4cQT` |
| Item | `[data-caption-item]`, `div[jsname="botPn"]`, else non-empty direct children |
| Speaker | `[data-speaker-name]`, `.NWpY1d`, `.zs7s8d`, `span.KcIKyf` |
| Text | `[data-message-text]`, `.ygicle`, `.iTTPOb`, `.bh44bd` |

If no container matches: `{ status: 'not_found' }`. The content script detaches
its observer, flushes any open caption, and retries on DOM mutations plus a 1s
scan — captions often appear only after the user turns them on.

When a text selector misses, `readCaptionItem` uses the node's `textContent`
minus a leading speaker label.

Adding a newly observed Meet selector means **prepending** it to the relevant
chain in `meetSelectors.ts` only.

## Manual path

Meet with captions on → start ScribeTab → speakers appear as bold `Name:` in the
side panel on audio segments (or immediately in captions-only) → stop → Library
export still includes speaker names in md/srt/vtt/json.
