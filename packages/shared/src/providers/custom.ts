import { openAiCompatible } from './openaiCompatible';

// The local-model story: any OpenAI-compatible server (whisper.cpp server,
// Speaches, LM Studio) on a user-supplied baseUrl. No response_format extra
// field: plain `json` is the lowest common denominator across local servers;
// chunks then fall back to one segment per chunk, which is fine for live view.
export const customProvider = openAiCompatible({
  id: 'custom',
  defaultModel: 'whisper-1', // many local servers ignore the field; OpenAI dialect requires it
  requiresApiKey: false,
});
