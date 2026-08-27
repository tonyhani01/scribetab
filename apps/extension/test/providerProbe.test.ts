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
