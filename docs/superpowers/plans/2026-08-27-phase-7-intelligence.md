# Phase 7 — Intelligence

**Date:** 2026-08-27
**Status:** Implemented
**Roadmap:** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md` Phase 7
**Branch:** `phase-7-intelligence`

## Goal

On session finalize, optionally produce a meeting summary + action-item checklist via an LLM, redact PII from transcript text, and show an estimated per-session cost (STT minutes + LLM tokens). Local summaries work through a custom OpenAI-compatible chat endpoint (Ollama / LM Studio).

## File map

### `packages/shared`

| File | Role |
|---|---|
| `src/llm/openaiCompatibleChat.ts` | OpenAI `POST {base}/chat/completions` factory |
| `src/llm/openai-chat.ts` | `openai` adapter (`gpt-4o-mini`) |
| `src/llm/custom-chat.ts` | `custom` adapter (baseUrl required, key optional) |
| `src/llm/index.ts` | Registry + `llmEndpoint` (mirrors STT) |
| `src/summarize.ts` | Prompt builders, parsers, `summarizeMeeting` |
| `src/redact.ts` | Emails, phones, Luhn cards, SSNs, extra terms |
| `src/costs.ts` | Conservative list-price table + token/duration math |
| `src/export/{markdown,json}.ts` | Optional `summaryMarkdown` / `costUsd` extras |
| `test/llmChat.test.ts` etc. | Mocked-fetch + fixture coverage |

Locked types in `src/types.ts` were not changed.

### `apps/extension`

| File | Role |
|---|---|
| `utils/settings.ts` | LLM provider/key/model/baseUrl, `redactAtRest`, `redactTerms` |
| `utils/sessionStore.ts` | `StoredSession` adds `summaryMarkdown` / `costUsd` (not locked) |
| `utils/intelligence.ts` | Finalize: redact-at-rest, LLM, cost total |
| `utils/messages.ts` | `OFFSCREEN_START.redaction` for ingest-time redaction |
| `entrypoints/background.ts` | Measure STT duration before audio delete; run intelligence once |
| `entrypoints/offscreen/main.ts` | Redact segment text before IndexedDB when enabled |
| `entrypoints/options/main.tsx` | LLM picker + masked key, redaction toggle + terms |
| `entrypoints/sidepanel/main.tsx` | Summary + estimated cost on library session view |
| `utils/exportDownload.ts` | Markdown/JSON export include extras |
| `test/intelligence.test.ts` | Finalize path with mocked chat completions |

## Decisions

1. **Do not extend locked `MeetingSession`.** Extra fields live on the IndexedDB row (`StoredSession`) and as optional `ExportExtras` on exporters. Host `sync_begin.summaryMarkdown` is already in the locked protocol; native host is Phase 5 and is not in this tree, so the field is stored and exported, ready for sync later.
2. **Redaction is text-only.** Applied before every LLM call. Applied before storage (and live side-panel delivery) when `redactAtRest` is on. Comments + options copy state that raw audio sent to STT cannot be pre-redacted.
3. **Cost figures are estimates.** `costs.ts` uses conservative published list prices and a 4-chars/token heuristic (`LlmProvider.complete` returns only a string). UI labels them `est.`
4. **Intelligence must not fail capture.** LLM errors leave `summaryMarkdown` unset and still record STT cost. `finalizeSession` stays idempotent; intelligence runs only on the first successful `complete` flip.
5. **STT adapters / chunker / capture engine are unchanged.** Duration is computed from stored WAV chunks *before* retention may delete them.

## Manual path

Configure an LLM (or Ollama `http://localhost:11434/v1`) → record → stop → Library → open session → summary, action items, and estimated cost. Markdown export includes the same block.
