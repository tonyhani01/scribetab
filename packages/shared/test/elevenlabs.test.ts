import { afterEach, describe, expect, it, vi } from 'vitest';
import { elevenLabsLanguageCode, elevenlabsProvider } from '../src/providers/elevenlabs';

const wav = Uint8Array.from({ length: 64 }, (_, i) => i % 256).buffer;
const req = { audio: wav, mimeType: 'audio/wav' };
const PINNED = 'https://api.elevenlabs.io/v1/speech-to-text';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function formOf(init: RequestInit): FormData {
  return init.body as FormData;
}

afterEach(() => vi.unstubAllGlobals());

describe('elevenLabsLanguageCode', () => {
  it('reduces BCP-47 hints to an ISO-639 primary subtag', () => {
    expect(elevenLabsLanguageCode('ar-EG')).toBe('ar');
    expect(elevenLabsLanguageCode('en_US')).toBe('en');
    expect(elevenLabsLanguageCode('zh-Hant-TW')).toBe('zh');
    expect(elevenLabsLanguageCode('ARA')).toBe('ara');
    expect(elevenLabsLanguageCode(' sv ')).toBe('sv');
  });

  it('drops hints that are not a 2–3 letter code', () => {
    expect(elevenLabsLanguageCode(undefined)).toBeUndefined();
    expect(elevenLabsLanguageCode('')).toBeUndefined();
    expect(elevenLabsLanguageCode('x')).toBeUndefined();
    expect(elevenLabsLanguageCode('english')).toBeUndefined();
    expect(elevenLabsLanguageCode('12-34')).toBeUndefined();
  });
});

describe('elevenlabsProvider request', () => {
  it('POSTs multipart to the pinned URL with xi-api-key and default settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'hello', words: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await elevenlabsProvider.transcribe(req, { apiKey: 'xi-key' });
    expect(result).toEqual({ text: 'hello', segments: undefined });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(PINNED);
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('xi-key');
    expect(init.headers.Authorization).toBeUndefined();
    const form = formOf(init);
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('tag_audio_events')).toBe('true');
    expect(form.get('language_code')).toBeNull();
    const file = form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(64);
  });

  it('normalizes the language hint and honors model overrides', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await elevenlabsProvider.transcribe({ ...req, language: 'ar-EG' }, { apiKey: 'k', model: 'scribe_v2_custom' });
    const form = formOf(fetchMock.mock.calls[0]![1]);
    expect(form.get('language_code')).toBe('ar');
    expect(form.get('model_id')).toBe('scribe_v2_custom');
  });

  it('falls back to scribe_v2 for a blank model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await elevenlabsProvider.transcribe(req, { apiKey: 'k', model: '  ' });
    expect(formOf(fetchMock.mock.calls[0]![1]).get('model_id')).toBe('scribe_v2');
  });

  it('ignores cfg.baseUrl so a stale custom URL cannot receive the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await elevenlabsProvider.transcribe(req, { apiKey: 'k', baseUrl: 'http://evil.example/v1' });
    expect(fetchMock.mock.calls[0]![0]).toBe(PINNED);
  });

  it('requires an apiKey and rejects header-only audio without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(elevenlabsProvider.transcribe(req, { apiKey: '' })).rejects.toThrow(/apiKey is required/);
    await expect(
      elevenlabsProvider.transcribe({ audio: new ArrayBuffer(44), mimeType: 'audio/wav' }, { apiKey: 'k' }),
    ).rejects.toThrow(/empty audio/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('elevenlabsProvider response', () => {
  const word = (text: string, start: number, end: number, speaker_id?: string, type = 'word') => ({
    text,
    start,
    end,
    speaker_id,
    type,
  });

  it('builds segments from words, splitting on speaker change and skipping spacing/events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          text: 'Hello world thanks',
          words: [
            word('Hello', 0.1, 0.45, 'speaker_0'),
            word(' ', 0.45, 0.5, 'speaker_0', 'spacing'),
            word('world', 0.5, 0.85, 'speaker_0'),
            word('(laughter)', 0.9, 1.0, 'speaker_0', 'audio_event'),
            word('thanks', 1.0, 1.4, 'speaker_1'),
          ],
        }),
      ),
    );
    const result = await elevenlabsProvider.transcribe(req, { apiKey: 'k' });
    expect(result.text).toBe('Hello world thanks');
    expect(result.segments).toEqual([
      { startMs: 100, endMs: 850, text: 'Hello world' },
      { startMs: 1000, endMs: 1400, text: 'thanks' },
    ]);
  });

  it('splits on silence gaps >1.5s and spans >12s, clamping endMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          text: '',
          words: [word('a', 0, 0.2), word('b', 2.0, 2.2), word('c', 2.3, 14.5), word('d', 15.0, 14.0)],
        }),
      ),
    );
    const result = await elevenlabsProvider.transcribe(req, { apiKey: 'k' });
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 200, text: 'a' },
      { startMs: 2000, endMs: 2200, text: 'b' },
      { startMs: 2300, endMs: 14500, text: 'c' },
      { startMs: 15000, endMs: 15000, text: 'd' },
    ]);
    // Blank top-level text falls back to the joined segments.
    expect(result.text).toBe('a b c d');
  });

  it('skips words with missing or non-numeric offsets and blank text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({
          text: 'kept',
          words: [{ text: 'x', start: '0.1', end: 0.2 }, { text: '  ', start: 0, end: 0.1 }, null, 7],
        }),
      ),
    );
    await expect(elevenlabsProvider.transcribe(req, { apiKey: 'k' })).resolves.toEqual({
      text: 'kept',
      segments: undefined,
    });
  });

  it('rejects malformed JSON, non-string text, and non-array words', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(elevenlabsProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(/malformed response/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ text: 12 })));
    await expect(elevenlabsProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(/malformed response/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ text: 'x', words: 'nope' })));
    await expect(elevenlabsProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(/malformed response/);
  });

  it('throws on an unrecognized 200 body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ transcript: 'hmm' })));
    await expect(elevenlabsProvider.transcribe(req, { apiKey: 'k' })).rejects.toThrow(
      /elevenlabs: unrecognized response.*transcript/,
    );
  });

  it('surfaces non-2xx errors and redacts the key from the body', async () => {
    const key = 'xi-secret-key-value';
    for (const status of [400, 401, 422, 429]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`denied for ${key}`, { status })));
      await expect(elevenlabsProvider.transcribe(req, { apiKey: key })).rejects.toThrow(
        new RegExp(`elevenlabs: HTTP ${status} denied for \\[key\\]`),
      );
    }
  });
});
