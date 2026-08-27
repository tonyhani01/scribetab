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

  it('round-trips at the 0x8000 chunk boundary and ±1', () => {
    for (const n of [0x7fff, 0x8000, 0x8001]) {
      const bytes = new Uint8Array(n);
      bytes[0] = 1;
      bytes[n - 1] = 2;
      const encoded = arrayBufferToBase64(bytes.buffer);
      const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(n);
      expect(decoded[0]).toBe(1);
      expect(decoded[n - 1]).toBe(2);
    }
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

  it('rejects 0-byte audio without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      googleProvider.transcribe({ audio: new ArrayBuffer(0), mimeType: 'audio/wav' }, { apiKey: 'k' }),
    ).rejects.toThrow(/empty audio/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on an unrecognized 200 body so the queue can mark failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ candidates: [{ foo: 'bar' }] })));
    await expect(googleProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(
      /google: unrecognized response.*candidates/,
    );
  });

  it('returns empty text only for an explicit empty output_text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ output_text: '' })));
    await expect(googleProvider.transcribe(req, { apiKey: 'k' })).resolves.toEqual({
      text: '',
      segments: undefined,
    });
  });

  it('maps numeric word_info offsets and skips unparseable ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          output_text: 'Hello thanks',
          steps: [
            {
              content: [
                {
                  annotations: [
                    { type: 'word_info', text: 'Hello', start_offset: 0.1, end_offset: 0.45 },
                    { type: 'word_info', text: 'skip', start_offset: 'n/a', end_offset: 1 },
                    {
                      type: 'word_info',
                      text: 'thanks',
                      start_offset: 1.0,
                      end_offset: 1.4,
                      speaker: 'spk_2',
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
      { startMs: 100, endMs: 450, text: 'Hello' },
      { startMs: 1000, endMs: 1400, text: 'thanks' },
    ]);
  });

  it('treats steps without content as no annotations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okJson({ output_text: 'only text', steps: [{ id: 's1' }] })),
    );
    const result = await googleProvider.transcribe(req, { apiKey: 'k' });
    expect(result).toEqual({ text: 'only text', segments: undefined });
  });

  it('skips blank annotation text and falls back to output_text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          output_text: 'kept',
          steps: [
            {
              content: [
                {
                  annotations: [
                    { type: 'word_info', text: '  ', start_offset: '0s', end_offset: '0.2s' },
                    { type: 'word_info', start_offset: '0.2s', end_offset: '0.4s' },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    const result = await googleProvider.transcribe(req, { apiKey: 'k' });
    expect(result).toEqual({ text: 'kept', segments: undefined });
  });

  it('splits segments on silence gaps >1.5s and length >12s, clamping endMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          output_text: 'a b c d',
          steps: [
            {
              content: [
                {
                  annotations: [
                    { type: 'word_info', text: 'a', start_offset: '0s', end_offset: '0.2s' },
                    { type: 'word_info', text: 'b', start_offset: '2.0s', end_offset: '2.2s' },
                    { type: 'word_info', text: 'c', start_offset: '2.3s', end_offset: '14.5s' },
                    { type: 'word_info', text: 'd', start_offset: '15.0s', end_offset: '14.0s' },
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
      { startMs: 0, endMs: 200, text: 'a' },
      { startMs: 2000, endMs: 2200, text: 'b' },
      { startMs: 2300, endMs: 14500, text: 'c' },
      { startMs: 15000, endMs: 15000, text: 'd' },
    ]);
  });
});
