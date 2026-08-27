import { openAiCompatible } from './openaiCompatible.js';

// OpenRouter STT is the OpenAI multipart dialect at
// POST https://openrouter.ai/api/v1/audio/transcriptions (Bearer).
// Routed ids from GET /api/v1/models?output_modalities=transcription (2026-08-27):
//   openai/whisper-large-v3       — default: whisper-class quality, widely routed
//   openai/whisper-large-v3-turbo — cheaper / faster
//   openai/whisper-1              — OpenAI-hosted Whisper (~$0.006/min)
//   google/chirp-3, openai/gpt-4o-mini-transcribe — higher-end alternatives
export function openRouterResponseFormat(model: string): 'verbose_json' | 'json' {
  const m = model.toLowerCase();
  if (m.includes('whisper') || m.startsWith('openai/')) return 'verbose_json';
  return 'json';
}

export const openrouterProvider = openAiCompatible({
  id: 'openrouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/whisper-large-v3',
  form: (model) => ({ response_format: openRouterResponseFormat(model) }),
});
