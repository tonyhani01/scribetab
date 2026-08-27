# Phase 10 — OpenRouter + Google STT adapters

**Date:** 2026-08-27
**Status:** Implemented
**Branch:** `phase-10-stt-providers`

## Goal

Add `openrouter` and `google` transcription adapters, wired through the
registry, options picker, connection probe, and endpoint pinning. Locked types
in `packages/shared/src/types.ts` are unchanged.

## Adapters

| Id | Transport | Default model | Pin |
| --- | --- | --- | --- |
| `openrouter` | OpenAI-compatible `POST {base}/audio/transcriptions` | `openai/whisper-large-v3` | `https://openrouter.ai/api/v1` |
| `google` | Interactions `POST /v1beta/interactions` | `gemini-3.5-transcribe` (public preview 2026-08-26) | `https://generativelanguage.googleapis.com/v1beta` |

OpenRouter default is whisper-class quality from the live
`/models?output_modalities=transcription` list. Alternatives (commented on the
adapter): `openai/whisper-large-v3-turbo`, `openai/whisper-1`, `google/chirp-3`,
`openai/gpt-4o-mini-transcribe`.

Google uses inline base64 WAV (`data`) for ≤8MiB chunks — no Files API. Keys
go in `x-goog-api-key`, never the URL. `cfg.baseUrl` is ignored.

## Costs

Unknown. OpenRouter mix per-second and per-minute `pricing.prompt` units across
whisper-class ids; Gemini 3.5 Transcribe is preview. UI shows `n/a`.

## Probe

- OpenRouter: `GET {pin}/models` with `Authorization: Bearer`
- Google: `GET {pin}/models?pageSize=1` with `x-goog-api-key`

## File map

| Area | Change |
| --- | --- |
| Shared adapters | `providers/openrouter.ts`, `providers/google.ts`, `base64.ts` |
| Registry | `providers/index.ts` + pinning tests |
| Extension | settings union, options labels/placeholders, `providerProbe.ts` |
| Docs | README provider table, store-listing key-header wording |
