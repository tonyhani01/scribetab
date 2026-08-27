import type { ChatMessage, LlmProvider, ProviderConfig } from '../types.js';

export interface OpenAiCompatibleChatOptions {
  id: string;
  defaultBaseUrl?: string; // absent → cfg.baseUrl is required (Ollama / LM Studio)
  defaultModel: string;
  requiresApiKey?: boolean; // default true; false for localhost servers
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
}

const TIMEOUT_MS = 120_000;

/**
 * Builds an LlmProvider for any endpoint speaking the OpenAI
 * `POST {base}/chat/completions` JSON dialect, including local servers
 * (Ollama, LM Studio) via a user-supplied baseUrl.
 */
export function openAiCompatibleChat(opts: OpenAiCompatibleChatOptions): LlmProvider {
  return {
    id: opts.id,
    async complete(messages: ChatMessage[], cfg: ProviderConfig): Promise<string> {
      // Official providers pin defaultBaseUrl so a leftover custom URL cannot leak keys.
      const baseUrl = (opts.defaultBaseUrl ?? cfg.baseUrl)?.replace(/\/+$/, '');
      if (!baseUrl) throw new Error(`${opts.id}: baseUrl is required`);
      if ((opts.requiresApiKey ?? true) && !cfg.apiKey) {
        throw new Error(`${opts.id}: apiKey is required`);
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model ?? opts.defaultModel,
          messages,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`${opts.id}: HTTP ${res.status} ${body}`);
      }

      let json: ChatCompletionResponse;
      try {
        json = (await res.json()) as ChatCompletionResponse;
      } catch {
        throw new Error(`${opts.id}: malformed JSON`);
      }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`${opts.id}: malformed JSON`);
      }
      return content;
    },
  };
}
