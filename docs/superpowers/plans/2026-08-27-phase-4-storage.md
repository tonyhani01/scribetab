# Phase 4 — Storage, search, export

**Date:** 2026-08-27
**Status:** Implemented
**Roadmap:** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md` Phase 4
**Branch:** `phase-4-storage`

## Goal

Past meetings persist in IndexedDB, show up in a side-panel Library, are full-text searchable, and export as markdown / JSON / SRT / VTT. Audio retention and a quota guard keep storage bounded.

## File map

### `packages/shared`

| File | Role |
|---|---|
| `src/export/markdown.ts` | `(session, segments) => markdown` |
| `src/export/json.ts` | pretty-printed `{ session, segments }` |
| `src/export/srt.ts` | SRT cues (`HH:MM:SS,mmm`, speaker prefix) |
| `src/export/vtt.ts` | WebVTT (`WEBVTT` + `<v Speaker>`) |
| `src/export/timestamps.ts` | clock / SRT / VTT formatters |
| `src/export/order.ts` | copy-sort by `startMs` (never mutates input) |
| `test/export.test.ts` | timestamps, speakers, empty list, ordering |

Locked types in `src/types.ts` were not changed.

### `apps/extension`

| File | Role |
|---|---|
| `utils/db.ts` | IndexedDB `scribetab` **v3**: `sessions` store; `audioChunks` re-keyed to `[sessionId, index]` + `bySession` |
| `utils/chunkStore.ts` | session-scoped put/get/delete/has |
| `utils/segmentStore.ts` | + `getAllSegments` / `deleteSegmentsForSession` |
| `utils/sessionStore.ts` | create / update / get / list / finalize / delete |
| `utils/settings.ts` | `retainAudio` (default `true`) |
| `utils/platform.ts` | URL → `meet` / `teams` / `zoom` / `youtube` / `other` |
| `utils/quota.ts` | warn >80%, drop oldest completed sessions' **audio only** until ≤70% |
| `utils/search.ts` | MiniSearch index + snippet helper |
| `utils/exportDownload.ts` | Blob-URL download of the four formats |
| `utils/assemble.ts` | assemble WAV for a given `sessionId` |
| `entrypoints/background.ts` | create session on start; finalize + quota on stop/end |
| `entrypoints/offscreen/main.ts` | write chunks with `sessionId`; do not wipe prior sessions |
| `entrypoints/options/main.tsx` | retain-audio checkbox |
| `entrypoints/sidepanel/main.tsx` | Live / Library tabs, search, per-format export |
| `entrypoints/popup/main.tsx` | download uses `currentSessionId` |
| `test/*.test.ts` | store, quota policy, platform, search, filenames |

## Decisions

1. **Drop v1/v2 chunk rows on upgrade** instead of migrating. Pre-release chunks have no `sessionId`, so they cannot be re-homed. Comment is in `db.ts` `onupgradeneeded`.
2. **Do not `clear()` chunks/segments on a new capture.** Rows are keyed by session; wiping would destroy retained meetings.
3. **`finalizeSession` is idempotent.** First call while `status === 'recording'` wins (status + optional audio delete). Later calls no-op, so stop + `CAPTURE_ENDED` can both invoke it.
4. **Quota deletes audioChunks only** of `status === 'complete'` sessions, oldest `startedAt` first — never segments, never session rows, never in-progress recordings.
5. **MiniSearch is built on demand** from IndexedDB when the Library tab loads, not kept as a persistent store.
6. **Extension tests** use Vitest + `fake-indexeddb`. `wxt prepare` runs first so `tsconfig.json`'s `.wxt` extend exists.

## Manual path

Record a tab → stop → open side panel **Library** → session listed (title, date, duration) → search a word from the transcript → open session → Export `.md` / `.json` / `.srt` / `.vtt`.
