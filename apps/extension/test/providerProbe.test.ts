import { describe, expect, it, vi } from 'vitest';
import {
  llmProbeRequest,
  probeLlm,
  probeTranscription,
  sttProbeRequest,
  validateHttpUrl,
} from '../utils/providerProbe';

describe('validateHttpUrl', () => {
  it('rejects empty, non-http, and malformed URLs', () => {
    expect(validateHttpUrl('')).toMatch(/http/i);
    expect(validateHttpUrl('not a url')).toMatch(/valid URL/i);
    expect(validateHttpUrl('ftp://localhost/v1')).toMatch(/http/i);
    expect(validateHttpUrl('http://localhost:8080/v1')).toBeNull();
  });
});

describe('probe request URLs', () => {
  it('uses /models for OpenAI-compatible STT and LLM', () => {
    expect(sttProbeRequest('openai', 'sk', '').url).toBe('https://api.openai.com/v1/models');
    expect(llmProbeRequest('openai', 'sk', '').url).toBe('https://api.openai.com/v1/models');
    expect(sttProbeRequest('custom', '', 'http://127.0.0.1:8080/v1').url).toBe(
      'http://127.0.0.1:8080/v1/models',
    );
  });

  it('pins openai to api.openai.com even with a stale custom baseUrl', () => {
    expect(sttProbeRequest('openai', 'sk', 'http://localhost:9000/v1').url).toBe(
      'https://api.openai.com/v1/models',
    );
    expect(llmProbeRequest('openai', 'sk', 'http://localhost:11434/v1').url).toBe(
      'https://api.openai.com/v1/models',
    );
  });

  it('uses Deepgram projects with Token auth', () => {
    const req = sttProbeRequest('deepgram', 'dg', '');
    expect(req.url).toBe('https://api.deepgram.com/v1/projects');
    expect(req.headers.Authorization).toBe('Token dg');
  });

  it('probes OpenRouter /key with Bearer auth on the pinned host', () => {
    const req = sttProbeRequest('openrouter', 'or-key', 'http://evil.example/v1');
    expect(req.url).toBe('https://openrouter.ai/api/v1/key');
    expect(req.headers.Authorization).toBe('Bearer or-key');
  });

  it('probes Google models with x-goog-api-key and no key in the URL', () => {
    const req = sttProbeRequest('google', 'g-key', 'http://evil.example/v1');
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    );
    expect(req.url).not.toMatch(/g-key/);
    expect(req.headers['x-goog-api-key']).toBe('g-key');
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('probes ElevenLabs /v1/user with xi-api-key on the pinned host', () => {
    const req = sttProbeRequest('elevenlabs', 'xi-key', 'http://evil.example/v1');
    expect(req.url).toBe('https://api.elevenlabs.io/v1/user');
    expect(req.url).not.toMatch(/xi-key/);
    expect(req.headers['xi-api-key']).toBe('xi-key');
    expect(req.headers.Authorization).toBeUndefined();
  });
});

describe('probeTranscription', () => {
  it('does not fetch when a cloud key is missing', async () => {
    const fetchImpl = vi.fn();
    const res = await probeTranscription({
      providerId: 'openai',
      apiKey: '',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps HTTP 401 to a key-rejected message', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const res = await probeTranscription({
      providerId: 'openai',
      apiKey: 'sk-test',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/rejected/i);
  });

  it('classifies OpenRouter HTTP 401 as a bad key', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const res = await probeTranscription({
      providerId: 'openrouter',
      apiKey: 'or-bad',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/key');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/rejected/i);
  });

  it('classifies OpenRouter fetch failure as a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const res = await probeTranscription({
      providerId: 'openrouter',
      apiKey: 'or-key',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/could not reach/i);
  });

  it('succeeds on HTTP 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const res = await probeLlm({
      providerId: 'custom',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, message: 'Connected.' });
  });

  it('reports custom STT /models 404 as reachable without models', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const res = await probeTranscription({
      providerId: 'custom',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8080/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/models endpoint not supported/i);
  });

  it('still treats cloud STT HTTP 404 as a bad URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const res = await probeTranscription({
      providerId: 'openai',
      apiKey: 'sk-test',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/404/);
  });

  it('requests only the ElevenLabs origin and sends no audio', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const origins: string[] = [];
    const res = await probeTranscription({
      providerId: 'elevenlabs',
      apiKey: 'xi-key',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ensureOrigin: async (o) => {
        origins.push(o);
        return true;
      },
    });
    expect(res.ok).toBe(true);
    expect(origins).toEqual(['https://api.elevenlabs.io/*']);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/user');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('stops when host permission is declined', async () => {
    const fetchImpl = vi.fn();
    const res = await probeTranscription({
      providerId: 'openai',
      apiKey: 'sk',
      baseUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ensureOrigin: async () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/declined/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
