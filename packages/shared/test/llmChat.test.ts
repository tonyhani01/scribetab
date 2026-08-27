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
      stream?: boolean;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual(messages);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBeUndefined();
  });

  it('ignores cfg.baseUrl so a stale custom URL cannot receive the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ choices: [{ message: { content: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await openaiChatProvider.complete(messages, {
      apiKey: 'sk-x',
      baseUrl: 'http://evil.example/v1',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
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

function sseEvent(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function sseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('openaiChatProvider.stream', () => {
  it('POSTs stream:true and assembles delta.content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseStream([
        sseEvent({ choices: [{ delta: { content: 'Hel' } }] }),
        sseEvent({ choices: [{ delta: { content: 'lo' } }] }),
        sseEvent('[DONE]'),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'sk-x' }, (t) =>
      deltas.push(t),
    );
    expect(result).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { stream?: boolean };
    expect(body.stream).toBe(true);
  });

  it('skips malformed lines and role-only chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseStream([
          sseEvent({ choices: [{ delta: { role: 'assistant' } }] }),
          sseEvent('not-json'),
          sseEvent({ choices: [{ delta: { content: 'ok' } }] }),
          sseEvent('[DONE]'),
        ]),
      ),
    );
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {});
    expect(result).toBe('ok');
  });

  it('assembles deltas split across ReadableStream chunks', async () => {
    const first = sseEvent({ choices: [{ delta: { content: 'ab' } }] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseStream([
          first.slice(0, 12),
          first.slice(12),
          sseEvent({ choices: [{ delta: { content: 'c' } }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {});
    expect(result).toBe('abc');
  });

  it('rejects on HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 })),
    );
    await expect(
      openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {}),
    ).rejects.toThrow(/openai: HTTP 401.*invalid api key/);
  });

  it('rejects a non-SSE body with no deltas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ choices: [{ message: { content: 'x' } }] })));
    await expect(
      openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {}),
    ).rejects.toThrow(/openai: malformed stream/);
  });

  it('treats a delta whose content is DONE as text, not a terminator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseStream([
          sseEvent({ choices: [{ delta: { content: 'DONE' } }] }),
          sseEvent({ choices: [{ delta: { content: '!' } }] }),
          sseEvent('[DONE]'),
        ]),
      ),
    );
    const deltas: string[] = [];
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'k' }, (t) =>
      deltas.push(t),
    );
    expect(result).toBe('DONE!');
    expect(deltas).toEqual(['DONE', '!']);
  });

  it('parses CRLF-delimited SSE frames', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\r\n\r\n`,
          'data: [DONE]\r\n\r\n',
        ]),
      ),
    );
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {});
    expect(result).toBe('Hi');
  });

  it('reassembles an SSE event split across reads', async () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ab' } }] })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseStream([event.slice(0, 17), event.slice(17), 'data: [DONE]\n\n']),
      ),
    );
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {});
    expect(result).toBe('ab');
  });

  it('assembles trailing data without a [DONE] terminator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseStream([`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}`]),
      ),
    );
    const result = await openaiChatProvider.stream!(messages, { apiKey: 'k' }, () => {});
    expect(result).toBe('ok');
  });
});
