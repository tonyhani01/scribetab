# Arabic STT provider research — 2026-08-29

**Status:** Research input for Phase 10+ provider decisions. No code changes proposed beyond what is flagged below.
**Scope:** Which transcription models are best for Arabic (MSA + Egyptian/Gulf/Levantine dialects), what they cost, how fast they are, and how each fits ScribeTab's BYOK, 45s-chunk, no-backend architecture.

## TL;DR

1. **Cohere Transcribe Arabic (07-2026)** is the accuracy leader for Arabic among open-weights models: avg WER **25.87** on the Open Universal Arabic ASR Leaderboard vs Whisper Large V3's **36.86**. Apache 2.0, 2B params, served by vLLM behind an OpenAI-compatible `/v1/audio/transcriptions` — it works with our existing `custom`/`openaiCompatible` adapter with **zero new code**.
2. Arabic WER numbers across vendors are **not comparable** (clean-MSA benchmarks show 5-10%, real conversational dialect speech shows mid-20s even for the best model). Use only the multi-dialect leaderboard for Arabic claims.
3. Whisper-class cloud endpoints (our current OpenRouter default `openai/whisper-large-v3`) are the *worst* quality tier for Arabic dialects: they normalize Egyptian/Gulf into stiff MSA and garble Arabic-English code-switching. Fine as the $0.08-0.45/hr budget option, but we must not advertise "great Arabic" off Whisper.
4. A **noise gate / VAD before the STT call** moves from nice-to-have to required if we recommend Cohere Arabic locally (its own model card: it hallucinates on floor noise). Our silence-boundary chunker mostly covers this; keep that.
5. Best managed-API additions for an "Arabic mode": **ElevenLabs Scribe v2** ($0.22/hr) and the already-implemented **Gemini 3.5 Transcribe** adapter (~$0.30/hr, auto language detection). Both are meaningfully better than Whisper on dialect + code-switching.

## Benchmark landscape (Arabic-specific)

Source: [Open Universal Arabic ASR Leaderboard](https://huggingface.co/spaces/elmresearchcenter/open_universal_arabic_asr_leaderboard) — zero-shot, six test sets spanning MSA, Egyptian (SADA), Gulf/Levantine/Maghrebi (Casablanca), MGB-2, MASC clean/noisy, Common Voice. As of 07-07-2026:

| Model | Avg WER | Notes |
| --- | --- | --- |
| **Cohere Transcribe Arabic 07-2026** | **25.87** | #1 open-weights. Best on SADA (37.47) and Casablanca (49.71) i.e. dialect conversational |
| OmniASR LLM 7B (Meta) | 28.32 | |
| Qwen3-Omni 30B | 30.71 | |
| Cohere Transcribe 03-2026 (base) | 30.67 | better only on MASC (broadcast/MSA) |
| Qwen3-ASR 1.7B | 33.36 | open, tiny, fast |
| Voxtral-Small 24B | 34.47 | |
| Whisper Large v3 | 36.86 | the cloud default everyone ships; worst of the leaders |

Human eval (native reviewers): Cohere Arabic preferred over Whisper in **95.8%** of pairwise tests; scores highest on dialect faithfulness (does not rewrite dialect into MSA) and preserves English loanwords in Latin script.

General (English-weighted) indices like Artificial Analysis AA-WER rank Scribe v2 / MAI-Transcribe top — useful for a mixed-language product, useless for Arabic-specific claims.

## Speed

- ScribeTab's floor is our 45s silence-chunk cadence; every batch provider below (speed factor 30-550x realtime) returns a chunk in well under a second, so provider speed is a non-differentiator for us. It only matters for user-hosted local instances.
- Cohere's vendor claim: RTFx 525 (their optimized vLLM stack). Treat as optimistic for self-hosting: a 2B Conformer on consumer hardware will be much slower than 525x but still far faster than real time. On Tony's M4 16GB, the model (~4GB BF16) runs via MLX/transformers for testing; expect usable-but-not-fast batch speeds, fine for chunk workloads.

## Pricing (USD per hour of audio)

| Option | $/hr audio | Arabic quality | ScribeTab fit |
| --- | --- | --- | --- |
| Local: cohere-transcribe-arabic via vLLM/transformers | free (hardware only) | best open Arabic | `custom` adapter already works; HF download requires gating agreement |
| Groq `whisper-large-v3-turbo` | $0.04 | weak dialects | implemented; cheapest default |
| OpenRouter `openai/whisper-large-v3-turbo` | $0.20 | weak dialects | implemented (see unit bug below) |
| OpenRouter `deepgram/nova-3` | $0.26 | 17 Arabic variants | available on same adapter |
| OpenRouter `mistralai/voxtral-mini-transcribe` | ~$0.36 | decent multilingual | available |
| OpenRouter `openai/gpt-transcribe` | $0.27 | good, MSA-leaning | available |
| OpenRouter `google/chirp-3` | $0.96 | broadcast-grade MSA | available |
| ElevenLabs Scribe v2 (direct API) | $0.22 batch / $0.39 realtime | strong multilingual + code-switch | new adapter candidate (~100 lines) |
| Gemini 3.5 Transcribe (direct API) | ~$0.30 (~$0.54 live) | very good, auto lang detect | **adapter already implemented** (Phase 10) |
| Deepgram Nova-3 (direct API) | $0.26 batch / $0.46 stream | 17 Arabic variants | adapter already implemented |
| Cohere hosted Transcribe Arabic API | per instance-hour, sales-gated | best hosted Arabic | poor BYOK fit; skip |
| Azure Speech / AWS Transcribe | $1.00 / $1.44 | legacy tiers, weaker | skip |

Verified live against `GET https://openrouter.ai/api/v1/models?output_modalities=transcription` (19 models). **Cohere Transcribe is not on OpenRouter**, so local vLLM is the only free-lunch Arabic route.

### OpenRouter pricing-unit trap (found during this research)

Model `pricing.prompt` units are mixed on that endpoint: some ids are **per-second** (`whisper-large-v3-turbo` 0.00000333/s = $0.012/min = $0.20/hr), some **per-minute** (`deepgram/nova-3` 0.0043/min = $0.26/hr), some per-token (`gpt-4o-mini-transcribe`). Verified: `packages/shared/src/costs.ts` already handles this correctly — rates are keyed by `(provider, model)` and OpenRouter/Gemini are deliberately unlisted (UI shows "n/a") instead of guessing. Also note OpenRouter returns a real `usage.cost` in responses and `openaiCompatible.ts` already parses it, so cost metering through the openrouter adapter gets exact costs from the provider itself, not the rate table. No fix needed.

## Cohere Arabic model card: limitations that matter for us

From the HF model card (read today, gated repo — access requires agreeing to contact-sharing on HF):

1. **No automatic language detection.** `language="ar" | "en"` must be specified; performance is inconsistent on heavily code-switched audio (the blog demo is cherry-picked; the card is honest). For a mixed Arabic/English meeting the user must pick a mode — or route those sessions to Gemini 3.5 Transcribe, which auto-detects.
2. **No timestamps, no diarization.** Fine: ScribeTab derives timing from chunk order and gets speakers from Meet caption fusion.
3. **Hallucinates on silence/noise** (like most AED models). Card recommends VAD/noise gate in front. Our RMS-silence chunker is the mitigation — worth stating in docs as a reason the chunker exists.
4. Input is resampled to 16kHz mono — our WAV assembly should downmix accordingly before upload.

## Recommendations

1. **Do:** Add a documented "local Arabic" recipe to README/docs: `vllm serve CohereLabs/cohere-transcribe-arabic-07-2026 --trust-remote-code` + point the `custom` OpenAI-compatible adapter at `http://localhost:8000/v1`. Cite leaderboard numbers with the "multi-dialect conversational WER" framing, not percentages from vendor homepages.
2. **Do:** In the options page, label Whisper-class providers honestly ("Arabic: MSA-biased, dialects normalized") and Gemini/ElevenLabs/Cohere-local as the Arabic-strong tier.
3. **Do next:** ElevenLabs Scribe v2 adapter ($0.22/hr is the best managed cloud price for Arabic-strong batch; one API key; existing batch-only transport fits our chunker).
4. **Don't:** Cohere hosted API as a provider (instance-hour pricing breaks the per-user BYOK model).
5. **Fix:** Cost-meter rate table for OpenRouter must resolve price per default model id and unit (see trap above).

## Sources

- Cohere blog + leaderboard table: https://cohere.com/blog/transcribe-arabic (2026-07-07)
- Model card (limitations, vLLM quickstart): https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026 (gated)
- Open Universal Arabic ASR Leaderboard: https://huggingface.co/spaces/elmresearchcenter/open_universal_arabic_asr_leaderboard
- Artificial Analysis STT leaderboard (speed/price, English-weighted): https://artificialanalysis.ai/speech-to-text/non-streaming
- Gemini 3.5 Transcribe pricing: https://ai.google.dev/gemini-api/docs/pricing
- ElevenLabs Scribe v2 pricing: https://elevenlabs.io/pricing/api
- Deepgram pricing: https://deepgram.com/pricing
- Groq STT pricing: https://console.groq.com/docs/speech-to-text
- OpenRouter transcription model list: live API query 2026-08-29
- MENA vendor comparison (methodology on why vendor WERs differ): https://munsit.com/blog/best-arabic-speech-to-text
