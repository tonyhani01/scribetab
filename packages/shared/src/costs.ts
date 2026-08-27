/**
 * Conservative published list prices used as *estimates* for the in-session
 * cost meter. These are not invoices, not guarantees, and will drift as
 * providers change pricing. Local/custom endpoints are $0.
 *
 * Sources (approx. public list, 2026): OpenAI Whisper $0.006/min; Groq
 * whisper-large-v3-turbo ~$0.04/hr; Deepgram Nova-2 payg ~$0.0043/min;
 * Mistral Voxtral in the same band as Whisper. OpenAI gpt-4o-mini
 * $0.15 / $0.60 per 1M input/output tokens.
 *
 * Rates are keyed by (provider, model). Unknown models return undefined so
 * the UI can show "n/a" instead of a wrong-by-16x guess.
 */

const STT_DEFAULT_MODEL: Readonly<Record<string, string>> = Object.freeze({
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
  deepgram: 'nova-2',
  mistral: 'voxtral-mini-latest',
});

const STT_USD_PER_MINUTE: Readonly<Record<string, number>> = Object.freeze({
  'openai:whisper-1': 0.006,
  'groq:whisper-large-v3-turbo': 0.00067,
  'deepgram:nova-2': 0.0043,
  'mistral:voxtral-mini-latest': 0.006,
});

const LLM_DEFAULT_MODEL: Readonly<Record<string, string>> = Object.freeze({
  openai: 'gpt-4o-mini',
});

const LLM_USD_PER_MILLION: Readonly<Record<string, { prompt: number; completion: number }>> =
  Object.freeze({
    'openai:gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  });

/** ~4 chars/token heuristic when the provider does not return usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function resolveModel(defaults: Readonly<Record<string, string>>, providerId: string, model?: string): string {
  const trimmed = model?.trim() ?? '';
  return trimmed || defaults[providerId] || '';
}

export function sttCostUsd(
  providerId: string,
  durationMs: number,
  model?: string,
): number | undefined {
  if (!(durationMs > 0)) return 0;
  if (providerId === 'custom') return 0;
  const resolved = resolveModel(STT_DEFAULT_MODEL, providerId, model);
  const rate = STT_USD_PER_MINUTE[`${providerId}:${resolved}`];
  if (rate === undefined) return undefined;
  return roundUsd((durationMs / 60_000) * rate);
}

export function llmCostUsd(
  providerId: string,
  promptTokens: number,
  completionTokens: number,
  model?: string,
): number | undefined {
  if (providerId === 'custom') return 0;
  const resolved = resolveModel(LLM_DEFAULT_MODEL, providerId, model);
  const rate = LLM_USD_PER_MILLION[`${providerId}:${resolved}`];
  if (!rate) return undefined;
  const prompt = Math.max(0, promptTokens);
  const completion = Math.max(0, completionTokens);
  return roundUsd((prompt * rate.prompt + completion * rate.completion) / 1_000_000);
}

/** Sum durations of segments that actually went through STT. */
export function audioTranscribedMs(
  segments: readonly { source: string; startMs: number; endMs: number }[],
): number {
  let ms = 0;
  for (const s of segments) {
    if (s.source !== 'audio') continue;
    const d = s.endMs - s.startMs;
    if (d > 0) ms += d;
  }
  return ms;
}

export function addCostUsd(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return roundUsd(a + b);
}

export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'n/a';
  if (!(n > 0)) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Duration of a 16-bit mono PCM WAV (44-byte header) at `sampleRate`. */
export function pcmWavDurationMs(byteLength: number, sampleRate: number): number {
  if (!(sampleRate > 0) || !(byteLength > 44)) return 0;
  const samples = (byteLength - 44) / 2;
  return Math.round((samples / sampleRate) * 1000);
}
