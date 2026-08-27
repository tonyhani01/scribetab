import { afterEach, describe, expect, it, vi } from 'vitest';
import { customChatProvider } from '../src/llm/custom-chat';
import { openaiChatProvider } from '../src/llm/openai-chat';
import type { ChatMessage } from '../src/types';

const messages: ChatMessage[] = [
  { role: 'system', content: 'You summarize meetings.' },
  { role: 'user', content: 'Hello team' },
];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('openaiChatProvider', () => {
  it('POSTs JSON chat completions with bearer auth and default model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ choices: [{ message: { content: 'A short summary.' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await openaiChatProvider.complete(messages, { apiKey: 'sk-x' });

    expect(result).toBe('A short summary.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-x');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: ChatMessage[];
      temperature: number;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual(messages);
    expect(body.temperature).toBe(0.2);
  });

  it('uses cfg.model override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ choices: [{ message: { content: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await openaiChatProvider.complete(messages, { apiKey: 'k', model: 'gpt-4o' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).model).toBe('gpt-4o');
  });

  it('throws with status and truncated body on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 })),
    );
    await expect(openaiChatProvider.complete(messages, { apiKey: 'k' })).rejects.toThrow(
      /openai: HTTP 401.*invalid api key/,
    );
  });

  it('throws on malformed JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(openaiChatProvider.complete(messages, { apiKey: 'k' })).rejects.toThrow(
      /openai: malformed JSON/,
    );
  });

  it('throws when choices[0].message.content is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ choices: [{ message: {} }] })));
    await expect(openaiChatProvider.complete(messages, { apiKey: 'k' })).rejects.toThrow(
      /openai: malformed JSON/,
    );
  });

  it('requires an apiKey', async () => {
    await expect(openaiChatProvider.complete(messages, { apiKey: '' })).rejects.toThrow(
      /apiKey is required/,
    );
  });
});

describe('customChatProvider', () => {
  it('requires baseUrl, tolerates empty apiKey, strips trailing slash', async () => {
    await expect(customChatProvider.complete(messages, { apiKey: '' })).rejects.toThrow(
      /baseUrl is required/,
    );

    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ choices: [{ message: { content: 'local' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await customChatProvider.complete(messages, {
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1/',
    });
    expect(result).toBe('local');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string).model).toBe('llama3.2');
  });

  it('throws on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('model not found', { status: 404 })),
    );
    await expect(
      customChatProvider.complete(messages, { apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' }),
    ).rejects.toThrow(/custom: HTTP 404.*model not found/);
  });

  it('throws on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ foo: 1 })));
    await expect(
      customChatProvider.complete(messages, { apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' }),
    ).rejects.toThrow(/custom: malformed JSON/);
  });
});
