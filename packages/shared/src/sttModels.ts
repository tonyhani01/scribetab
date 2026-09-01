/**
 * Curated STT model choices per provider, shown in Options instead of a
 * free-text field. Only ids the adapter can actually call are listed.
 * `allowCustom` keeps an explicit "custom model id" path for providers that
 * accept arbitrary compatible ids so a saved value is never silently dropped.
 */
export interface SttModelChoice {
  id: string;
  label: string;
  hint?: string;
}

export interface SttModelCatalog {
  choices: readonly SttModelChoice[];
  allowCustom: boolean;
  /** Provider-level helper text shown under the selector. */
  hint?: string;
}

export const STT_MODEL_CATALOG: Readonly<Record<string, SttModelCatalog>> = Object.freeze({
  elevenlabs: {
    choices: [{ id: 'scribe_v2', label: 'Scribe v2 — Recommended' }],
    allowCustom: false,
    hint:
      'Scribe v2: best for multilingual / code-switched meetings and speaker diarization. ' +
      'Word timestamps are always requested; diarization is toggleable below.',
  },
  google: {
    choices: [{ id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe' }],
    allowCustom: false,
    hint:
      'Verbatim mode (default) gives word timestamps and speaker diarization, which the live ' +
      "transcript needs. Gemini's Smart mode produces clean, formatted notes without timestamps " +
      'or diarization — pick it below if you prefer polished text.',
  },
  openrouter: {
    choices: [
      { id: 'openai/whisper-large-v3', label: 'Whisper Large v3 — Accuracy' },
      { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo — Budget' },
    ],
    allowCustom: true,
    hint: 'Whisper-class: MSA-biased for Arabic, dialects normalized. Any OpenRouter transcription id works via custom.',
  },
  openai: {
    choices: [{ id: 'whisper-1', label: 'Whisper (whisper-1) — Recommended' }],
    allowCustom: true,
    hint:
      'OpenAI hosts Whisper as whisper-1; there is no whisper-large-v3 id on api.openai.com. ' +
      'For Whisper Large v3 use Groq or OpenRouter. gpt-4o-transcribe models are not listed ' +
      'because they reject the verbose_json timestamps the adapter needs.',
  },
  groq: {
    choices: [
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo — Budget' },
      { id: 'whisper-large-v3', label: 'Whisper Large v3 — Accuracy' },
    ],
    allowCustom: true,
  },
  deepgram: {
    choices: [
      { id: 'nova-2', label: 'Nova-2' },
      { id: 'nova-3', label: 'Nova-3' },
    ],
    allowCustom: true,
  },
  mistral: {
    choices: [{ id: 'voxtral-mini-latest', label: 'Voxtral Mini' }],
    allowCustom: true,
  },
  custom: {
    choices: [{ id: 'whisper-1', label: 'whisper-1 (server default)' }],
    allowCustom: true,
    hint: 'Local servers usually ignore the model field.',
  },
});

export function sttModelCatalog(providerId: string): SttModelCatalog {
  return STT_MODEL_CATALOG[providerId] ?? { choices: [], allowCustom: true };
}

/** True when `model` is one of the curated choices (or blank = provider default). */
export function isCuratedSttModel(providerId: string, model: string): boolean {
  const m = model.trim();
  return m === '' || sttModelCatalog(providerId).choices.some((c) => c.id === m);
}
