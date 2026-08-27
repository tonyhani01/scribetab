import { openAiCompatible } from './openaiCompatible.js';

export const groqProvider = openAiCompatible({
  id: 'groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'whisper-large-v3-turbo',
  form: { response_format: 'verbose_json' },
});
