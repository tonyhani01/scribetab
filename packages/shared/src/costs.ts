/**
 * Conservative published list prices used as *estimates* for the in-session
 * cost meter. These are not invoices, not guarantees, and will drift as
 * providers change pricing. Local/custom endpoints are $0.
 *
 * Sources (approx. public list, 2026): OpenAI Whisper $0.006/min; Groq
 * whisper-large-v3-turbo ~$0.04/hr; Deepgram Nova-2 payg ~$0.0043/min;
 * Mistral Voxtral in the same band as Whisper. OpenAI gpt-4o-mini
 * $0.15 / $0.60 per 1M input/output tokens.
 */

export const STT_USD_PER_MINUTE: Readonly<Record<string, number>> = Object.freeze({
  openai: 0.006,
  groq: 0.00067,
  deepgram: 0.0043,
  mistral: 0.006,
  custom: 0,
});

export const LLM_USD_PER_MILLION: Readonly<
  Record<string, { prompt: number; completion: number }>
> = Object.freeze({
  openai: { prompt: 0.15, completion: 0.6 },
  custom: { prompt: 0, completion: 0 },
});

/** ~4 chars/token heuristic when the provider does not return usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function sttCostUsd(providerId: string, durationMs: number): number {
  if (!(durationMs > 0)) return 0;
  const rate = STT_USD_PER_MINUTE[providerId] ?? 0;
  return roundUsd((durationMs / 60_000) * rate);
}

export function llmCostUsd(
  providerId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = LLM_USD_PER_MILLION[providerId] ?? { prompt: 0, completion: 0 };
  const prompt = Math.max(0, promptTokens);
  const completion = Math.max(0, completionTokens);
  return roundUsd((prompt * rate.prompt + completion * rate.completion) / 1_000_000);
}

export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function formatUsd(n: number): string {
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
