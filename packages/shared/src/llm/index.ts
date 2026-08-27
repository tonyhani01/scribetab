import type { LlmProvider } from '../types.js';
import { customChatProvider } from './custom-chat.js';
import { openaiChatProvider } from './openai-chat.js';

export const LLM_PROVIDER_IDS = ['openai', 'custom'] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

const providers: Record<LlmProviderId, LlmProvider> = {
  openai: openaiChatProvider,
  custom: customChatProvider,
};

export function isLlmProviderId(id: string): id is LlmProviderId {
  return (LLM_PROVIDER_IDS as readonly string[]).includes(id);
}

export function getLlmProvider(id: string): LlmProvider {
  if (!isLlmProviderId(id)) throw new Error(`Unknown LLM provider: ${id}`);
  return providers[id];
}

const defaultBaseUrls: Record<LlmProviderId, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  custom: undefined,
};

/** Official cloud endpoints ignore a stale custom baseUrl so keys cannot leak. */
export function llmEndpoint(providerId: string, baseUrl?: string): string {
  if (providerId === 'custom') {
    if (!baseUrl) throw new Error(`${providerId}: baseUrl is required`);
    return baseUrl;
  }
  const d = isLlmProviderId(providerId) ? defaultBaseUrls[providerId] : undefined;
  if (!d) throw new Error(`${providerId}: baseUrl is required`);
  return d;
}

export { customChatProvider, openaiChatProvider };
export { openAiCompatibleChat } from './openaiCompatibleChat.js';
