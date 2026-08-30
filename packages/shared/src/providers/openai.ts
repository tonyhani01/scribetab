import { openAiCompatible } from './openaiCompatible.js';

// Whisper's `prompt` field carries the user's custom vocabulary (cfg.vocabHints)
// through the shared adapter.
export const openaiProvider = openAiCompatible({
  id: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'whisper-1',
  form: { response_format: 'verbose_json' },
});
