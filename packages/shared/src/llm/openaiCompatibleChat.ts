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

interface ChatCompletionDelta {
  choices?: { delta?: { content?: unknown } }[];
}

type SseExtract = { done: true } | { text: string };

const TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 300_000;

/**
 * Builds an LlmProvider for any endpoint speaking the OpenAI
 * `POST {base}/chat/completions` JSON dialect, including local servers
 * (Ollama, LM Studio) via a user-supplied baseUrl.
 */
export function openAiCompatibleChat(opts: OpenAiCompatibleChatOptions): LlmProvider {
  return {
    id: opts.id,
    async complete(messages: ChatMessage[], cfg: ProviderConfig): Promise<string> {
      const res = await postChat(opts, messages, cfg, false);
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
    async stream(
      messages: ChatMessage[],
      cfg: ProviderConfig,
      onDelta: (text: string) => void,
    ): Promise<string> {
      const res = await postChat(opts, messages, cfg, true);
      return readSse(res, opts.id, onDelta);
    },
  };
}

async function postChat(
  opts: OpenAiCompatibleChatOptions,
  messages: ChatMessage[],
  cfg: ProviderConfig,
  stream: boolean,
): Promise<Response> {
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
      ...(stream ? { stream: true } : {}),
    }),
    signal: AbortSignal.timeout(stream ? STREAM_TIMEOUT_MS : TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${opts.id}: HTTP ${res.status} ${body}`);
  }
  return res;
}

async function readSse(
  res: Response,
  id: string,
  onDelta: (text: string) => void,
): Promise<string> {
  if (!res.body) throw new Error(`${id}: empty body`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let sawDone = false;

  const consume = (part: string): boolean => {
    const piece = extractSseData(part);
    if (!piece) return false;
    if ('done' in piece) return true;
    full += piece.text;
    onDelta(piece.text);
    return false;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (consume(part)) {
          sawDone = true;
          break;
        }
      }
      if (sawDone || done) break;
    }
    if (!sawDone && buffer.trim()) {
      sawDone = consume(buffer);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  if (!full && !sawDone) throw new Error(`${id}: malformed stream`);
  return full;
}

/** Split on SSE events; skip malformed `data:` lines; `[DONE]` terminates. */
function extractSseData(part: string): SseExtract | null {
  let content = '';
  for (const rawLine of part.split(/\r?\n/)) {
    if (!rawLine.startsWith('data:')) continue;
    let data = rawLine.slice('data:'.length);
    if (data.startsWith(' ')) data = data.slice(1);
    if (data === '[DONE]') return { done: true };
    try {
      const json = JSON.parse(data) as ChatCompletionDelta;
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) content += delta;
    } catch {
      // malformed lines are skipped
    }
  }
  return content ? { text: content } : null;
}
