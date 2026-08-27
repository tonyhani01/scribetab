import { openAiCompatibleChat } from './openaiCompatibleChat.js';

// The local-model story: any OpenAI-compatible chat server (Ollama, LM Studio)
// on a user-supplied baseUrl. No API key required for typical localhost setups.
export const customChatProvider = openAiCompatibleChat({
  id: 'custom',
  defaultModel: 'llama3.2',
  requiresApiKey: false,
});
