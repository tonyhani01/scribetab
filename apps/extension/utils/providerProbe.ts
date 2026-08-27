import { llmEndpoint, originPattern, transcriptionEndpoint } from '@scribetab/shared';

const PROBE_TIMEOUT_MS = 8_000;

export type ProbeResult = { ok: boolean; message: string };

export function validateHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Enter an http(s) URL.';
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return 'That does not look like a valid URL.';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'URL must start with http:// or https://.';
  }
  return null;
}

function join(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, '')}${path}`;
}

function classifyHttp(status: number): string {
  if (status === 401 || status === 403) return 'The API key was rejected.';
  if (status === 404) return 'The provider URL looks wrong (404).';
  if (status >= 500) return 'The provider returned a server error.';
  return `The provider returned HTTP ${status}.`;
}

async function ping(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  opts?: { customStt?: boolean },
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, message: 'Connected.' };
    if (opts?.customStt && res.status === 404) {
      return { ok: true, message: 'reachable (models endpoint not supported)' };
    }
    return { ok: false, message: classifyHttp(res.status) };
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, message: 'The provider did not respond in time.' };
    }
    return {
      ok: false,
      message: 'Could not reach the provider. Check the URL, network, and host permission.',
    };
  }
}

export function sttProbeRequest(
  providerId: string,
  apiKey: string,
  baseUrl: string,
): { url: string; headers: Record<string, string> } {
  const endpoint = transcriptionEndpoint(providerId, baseUrl.trim() || undefined);
  const headers: Record<string, string> = {};
  if (providerId === 'deepgram') {
    if (apiKey) headers.Authorization = `Token ${apiKey}`;
    return { url: join(endpoint, '/v1/projects'), headers };
  }
  if (providerId === 'google') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    return { url: join(endpoint, '/models?pageSize=1'), headers };
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { url: join(endpoint, '/models'), headers };
}

export function llmProbeRequest(
  providerId: string,
  apiKey: string,
  baseUrl: string,
): { url: string; headers: Record<string, string> } {
  const endpoint = llmEndpoint(providerId, baseUrl.trim() || undefined);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { url: join(endpoint, '/models'), headers };
}

export async function probeTranscription(opts: {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  ensureOrigin?: (origin: string) => Promise<boolean>;
}): Promise<ProbeResult> {
  if (opts.providerId === '') return { ok: false, message: 'Choose a transcription provider first.' };
  if (opts.providerId === 'custom') {
    const bad = validateHttpUrl(opts.baseUrl);
    if (bad) return { ok: false, message: bad };
  } else if (!opts.apiKey.trim()) {
    return { ok: false, message: 'This provider needs an API key.' };
  }

  let req: { url: string; headers: Record<string, string> };
  try {
    req = sttProbeRequest(opts.providerId, opts.apiKey, opts.baseUrl);
  } catch {
    return { ok: false, message: 'Enter a valid http(s) base URL for the custom provider.' };
  }

  if (opts.ensureOrigin) {
    const granted = await opts.ensureOrigin(originPattern(req.url));
    if (!granted) {
      return { ok: false, message: 'Permission was declined, so that provider cannot be reached.' };
    }
  }

  return ping(req.url, req.headers, opts.fetchImpl ?? fetch, {
    customStt: opts.providerId === 'custom',
  });
}

export async function probeLlm(opts: {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  ensureOrigin?: (origin: string) => Promise<boolean>;
}): Promise<ProbeResult> {
  if (opts.providerId === '') return { ok: false, message: 'Choose an LLM provider first.' };
  if (opts.providerId === 'custom') {
    const bad = validateHttpUrl(opts.baseUrl);
    if (bad) return { ok: false, message: bad };
  } else if (!opts.apiKey.trim()) {
    return { ok: false, message: 'This provider needs an API key.' };
  }

  let req: { url: string; headers: Record<string, string> };
  try {
    req = llmProbeRequest(opts.providerId, opts.apiKey, opts.baseUrl);
  } catch {
    return { ok: false, message: 'Enter a valid http(s) base URL for the custom provider.' };
  }

  if (opts.ensureOrigin) {
    const granted = await opts.ensureOrigin(originPattern(req.url));
    if (!granted) {
      return { ok: false, message: 'Permission was declined, so that provider cannot be reached.' };
    }
  }

  return ping(req.url, req.headers, opts.fetchImpl ?? fetch);
}

/** Must run on the click path with no prior await (user-gesture for request()). */
export function ensureHostOrigin(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [origin] });
}
