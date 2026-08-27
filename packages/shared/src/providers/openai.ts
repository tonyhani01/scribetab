import { openAiCompatible } from './openaiCompatible.js';

export const openaiProvider = openAiCompatible({
  id: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'whisper-1',
  form: { response_format: 'verbose_json' },
});
