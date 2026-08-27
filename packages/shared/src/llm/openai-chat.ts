import { openAiCompatibleChat } from './openaiCompatibleChat.js';

export const openaiChatProvider = openAiCompatibleChat({
  id: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
});
