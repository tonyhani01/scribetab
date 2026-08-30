import { openAiCompatible } from './openaiCompatible.js';

// Groq's Whisper endpoint takes the same `prompt` vocabulary hook as OpenAI.
export const groqProvider = openAiCompatible({
  id: 'groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'whisper-large-v3-turbo',
  form: { response_format: 'verbose_json' },
});
