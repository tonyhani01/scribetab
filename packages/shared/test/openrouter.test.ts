import { afterEach, describe, expect, it, vi } from 'vitest';
import { openrouterProvider } from '../src/providers/openrouter';

const wav = new ArrayBuffer(8);
const req = { audio: wav, mimeType: 'audio/wav' };

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('openrouterProvider', () => {
  it('POSTs multipart form to the pinned OpenRouter transcriptions URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'hello' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await openrouterProvider.transcribe(req, { apiKey: 'or-key' });

    expect(result.text).toBe('hello');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer or-key');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('openai/whisper-large-v3');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('maps verbose_json segments (seconds → ms) and usage.cost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          text: 'hello there',
          language: 'en',
          duration: 4.048,
          segments: [
            { start: 0, end: 1.5, text: ' hello' },
            { start: 1.5, end: 4.048, text: ' there' },
          ],
          usage: { seconds: 4.048, cost: 0.00003036 },
        }),
      ),
    );
    const result = await openrouterProvider.transcribe(req, { apiKey: 'or-key' });
    expect(result.text).toBe('hello there');
    expect(result.costUsd).toBe(0.00003036);
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1500, text: ' hello' },
      { startMs: 1500, endMs: 4048, text: ' there' },
    ]);
  });

  it('rejects 0-byte audio without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      openrouterProvider.transcribe({ audio: new ArrayBuffer(0), mimeType: 'audio/wav' }, { apiKey: 'k' }),
    ).rejects.toThrow(/empty audio/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores cfg.baseUrl so a stale custom URL cannot receive the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'hello' }));
    vi.stubGlobal('fetch', fetchMock);
    await openrouterProvider.transcribe(req, {
      apiKey: 'or-key',
      baseUrl: 'http://evil.example/v1',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://openrouter.ai/api/v1/audio/transcriptions',
    );
  });

  it('passes language and cfg.model overrides through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await openrouterProvider.transcribe(
      { ...req, language: 'sv' },
      { apiKey: 'k', model: 'google/chirp-3' },
    );
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get('language')).toBe('sv');
    expect(form.get('model')).toBe('google/chirp-3');
  });

  it('throws with status and truncated body on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );
    await expect(openrouterProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(
      /openrouter: HTTP 429.*rate limited/,
    );
  });

  it('rejects malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(openrouterProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow();
  });

  it('requires an apiKey', async () => {
    await expect(openrouterProvider.transcribe(req, { apiKey: '' })).rejects.toThrow(
      /apiKey is required/,
    );
  });
});
