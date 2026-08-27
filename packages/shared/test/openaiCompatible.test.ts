import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiProvider } from '../src/providers/openai';
import { groqProvider } from '../src/providers/groq';
import { mistralProvider } from '../src/providers/mistral';
import { customProvider } from '../src/providers/custom';

const wav = new ArrayBuffer(8);
const req = { audio: wav, mimeType: 'audio/wav' };

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('openAiCompatible', () => {
  it('POSTs multipart form to {base}/audio/transcriptions with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'hello' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await openaiProvider.transcribe(req, { apiKey: 'sk-x' });

    expect(result.text).toBe('hello');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-x');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('maps verbose_json segments from seconds to chunk-relative ms', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({
      text: 'one two',
      segments: [
        { start: 0, end: 1.5, text: ' one' },
        { start: 1.5, end: 3.25, text: ' two' },
      ],
    })));
    const result = await openaiProvider.transcribe(req, { apiKey: 'k' });
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1500, text: ' one' },
      { startMs: 1500, endMs: 3250, text: ' two' },
    ]);
  });

  it('passes language and cfg.model overrides through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await openaiProvider.transcribe({ ...req, language: 'de' }, { apiKey: 'k', model: 'gpt-4o-transcribe' });
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get('language')).toBe('de');
    expect(form.get('model')).toBe('gpt-4o-transcribe');
  });

  it('throws with status and truncated body on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    ));
    await expect(openaiProvider.transcribe(req, { apiKey: 'k' }))
      .rejects.toThrow(/openai: HTTP 429.*rate limited/);
  });

  it('requires an apiKey unless the factory opts out', async () => {
    await expect(openaiProvider.transcribe(req, { apiKey: '' }))
      .rejects.toThrow(/apiKey is required/);
  });

  it('groq uses its base url and default model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'g' }));
    vi.stubGlobal('fetch', fetchMock);
    await groqProvider.transcribe(req, { apiKey: 'k' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((fetchMock.mock.calls[0]![1].body as FormData).get('model')).toBe('whisper-large-v3-turbo');
  });

  it('mistral requests segment timestamps instead of verbose_json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'm' }));
    vi.stubGlobal('fetch', fetchMock);
    await mistralProvider.transcribe(req, { apiKey: 'k' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.mistral.ai/v1/audio/transcriptions');
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get('timestamp_granularities')).toBe('segment');
    expect(form.get('response_format')).toBeNull();
  });

  it('custom requires baseUrl, tolerates empty apiKey, strips trailing slash', async () => {
    await expect(customProvider.transcribe(req, { apiKey: '' }))
      .rejects.toThrow(/baseUrl is required/);

    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'local' }));
    vi.stubGlobal('fetch', fetchMock);
    await customProvider.transcribe(req, { apiKey: '', baseUrl: 'http://localhost:8080/v1/' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8080/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBeUndefined();
  });
});
