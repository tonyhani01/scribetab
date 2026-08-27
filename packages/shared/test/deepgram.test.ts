import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepgramProvider } from '../src/providers/deepgram';

const req = { audio: new ArrayBuffer(8), mimeType: 'audio/wav' };

afterEach(() => vi.unstubAllGlobals());

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('deepgramProvider', () => {
  it('POSTs raw audio with Token auth and utterances enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      results: { channels: [{ alternatives: [{ transcript: 'hi there' }] }] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deepgramProvider.transcribe(req, { apiKey: 'dg-key' });

    expect(result.text).toBe('hi there');
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.origin).toBe('https://api.deepgram.com');
    expect(u.pathname).toBe('/v1/listen');
    expect(u.searchParams.get('model')).toBe('nova-2');
    expect(u.searchParams.get('utterances')).toBe('true');
    expect(u.searchParams.get('smart_format')).toBe('true');
    expect(init.headers.Authorization).toBe('Token dg-key');
    expect(init.headers['Content-Type']).toBe('audio/wav');
    expect(init.body).toBe(req.audio);
  });

  it('maps utterances to chunk-relative ms segments', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({
      results: {
        channels: [{ alternatives: [{ transcript: 'a b' }] }],
        utterances: [
          { start: 0.5, end: 2, transcript: 'a' },
          { start: 2, end: 4.75, transcript: 'b' },
        ],
      },
    })));
    const result = await deepgramProvider.transcribe(req, { apiKey: 'k' });
    expect(result.segments).toEqual([
      { startMs: 500, endMs: 2000, text: 'a' },
      { startMs: 2000, endMs: 4750, text: 'b' },
    ]);
  });

  it('passes language and model overrides as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ results: { channels: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await deepgramProvider.transcribe({ ...req, language: 'en-GB' }, { apiKey: 'k', model: 'nova-3' });
    const u = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(u.searchParams.get('language')).toBe('en-GB');
    expect(u.searchParams.get('model')).toBe('nova-3');
  });

  it('requires an apiKey and surfaces HTTP errors', async () => {
    await expect(deepgramProvider.transcribe(req, { apiKey: '' }))
      .rejects.toThrow(/apiKey is required/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));
    await expect(deepgramProvider.transcribe(req, { apiKey: 'k' }))
      .rejects.toThrow(/deepgram: HTTP 401.*bad key/);
  });
});
