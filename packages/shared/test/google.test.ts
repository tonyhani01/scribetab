import { afterEach, describe, expect, it, vi } from 'vitest';
import { arrayBufferToBase64 } from '../src/base64';
import { googleProvider } from '../src/providers/google';

const wav = Uint8Array.from([1, 2, 3, 4]).buffer;
const req = { audio: wav, mimeType: 'audio/wav' };

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('arrayBufferToBase64', () => {
  it('round-trips bytes without spreading the whole buffer', () => {
    const bytes = Uint8Array.from([0, 1, 254, 255]);
    const encoded = arrayBufferToBase64(bytes.buffer);
    expect(encoded).toBe(btoa(String.fromCharCode(0, 1, 254, 255)));
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([0, 1, 254, 255]);
  });

  it('encodes buffers larger than a single fromCharCode apply', () => {
    const bytes = new Uint8Array(200_000);
    bytes[0] = 9;
    bytes[199_999] = 7;
    const encoded = arrayBufferToBase64(bytes.buffer);
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(200_000);
    expect(decoded[0]).toBe(9);
    expect(decoded[199_999]).toBe(7);
  });
});

describe('googleProvider', () => {
  it('POSTs JSON to the pinned interactions URL with x-goog-api-key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ output_text: 'hello there' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await googleProvider.transcribe(req, { apiKey: 'g-key' });

    expect(result.text).toBe('hello there');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(String(url)).not.toMatch(/g-key/);
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('g-key');
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gemini-3.5-transcribe');
    expect(body.input).toEqual([
      { type: 'audio', data: arrayBufferToBase64(wav), mime_type: 'audio/wav' },
    ]);
    expect(body.generation_config).toBeUndefined();
  });

  it('omits language_codes without a hint and includes them when present', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okJson({ output_text: '' })));
    vi.stubGlobal('fetch', fetchMock);

    await googleProvider.transcribe(req, { apiKey: 'k' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).generation_config).toBeUndefined();

    await googleProvider.transcribe({ ...req, language: 'sv-SE' }, { apiKey: 'k' });
    const withLang = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(withLang.generation_config).toEqual({
      transcription_config: { language_codes: ['sv-SE'] },
    });
  });

  it('ignores cfg.baseUrl so a stale custom URL cannot receive the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ output_text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await googleProvider.transcribe(req, { apiKey: 'g-key', baseUrl: 'http://evil.example/v1' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
  });

  it('honors cfg.model overrides', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ output_text: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await googleProvider.transcribe(req, { apiKey: 'k', model: 'gemini-3.5-transcribe-preview' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).model).toBe(
      'gemini-3.5-transcribe-preview',
    );
  });

  it('maps word_info annotations into coarse segments when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          output_text: 'Hello world thanks',
          steps: [
            {
              content: [
                {
                  annotations: [
                    {
                      type: 'word_info',
                      text: 'Hello',
                      speaker: 'spk_1',
                      start_offset: '0.100s',
                      end_offset: '0.450s',
                    },
                    {
                      type: 'word_info',
                      text: 'world',
                      speaker: 'spk_1',
                      start_offset: '0.500s',
                      end_offset: '0.850s',
                    },
                    {
                      type: 'word_info',
                      text: 'thanks',
                      speaker: 'spk_2',
                      start_offset: '1.000s',
                      end_offset: '1.400s',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    const result = await googleProvider.transcribe(req, { apiKey: 'k' });
    expect(result.segments).toEqual([
      { startMs: 100, endMs: 850, text: 'Hello world' },
      { startMs: 1000, endMs: 1400, text: 'thanks' },
    ]);
  });

  it('surfaces HTTP 400/401/429 with truncated error JSON', async () => {
    for (const status of [400, 401, 429]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message: 'nope', code: status } }), { status }),
        ),
      );
      await expect(googleProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(
        new RegExp(`google: HTTP ${status}.*nope`),
      );
    }
  });

  it('rejects malformed JSON and non-string output_text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(googleProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(
      /google: malformed response/,
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ output_text: 12 })));
    await expect(googleProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(
      /google: malformed response/,
    );
  });

  it('requires an apiKey', async () => {
    await expect(googleProvider.transcribe(req, { apiKey: '' })).rejects.toThrow(
      /apiKey is required/,
    );
  });
});
