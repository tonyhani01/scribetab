import type { LlmProvider } from '../types.js';
import { customChatProvider } from './custom-chat.js';
import { openaiChatProvider } from './openai-chat.js';

const providers: Record<string, LlmProvider> = {
  openai: openaiChatProvider,
  custom: customChatProvider,
};

export const LLM_PROVIDER_IDS = Object.freeze(Object.keys(providers));

export function getLlmProvider(id: string): LlmProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown LLM provider: ${id}`);
  return p;
}

const defaultBaseUrls: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  custom: undefined,
};

export function llmEndpoint(providerId: string, baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  const d = defaultBaseUrls[providerId];
  if (!d) throw new Error(`${providerId}: baseUrl is required`);
  return d;
}

export { customChatProvider, openaiChatProvider };
export { openAiCompatibleChat } from './openaiCompatibleChat.js';
