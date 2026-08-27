# Phase 3 — Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live transcript of a captured tab in a side panel: WAV chunks flow from the Phase 2 capture engine through a BYOK provider adapter into `TranscriptSegment`s rendered as they arrive.

**Architecture:** Pure, unit-tested logic lives in `packages/shared` (provider adapters, retry queue, segment mapping, origin-pattern helper). The extension adds thin glue: an options page that stores settings and requests host permission, a service worker that passes a session id + settings to the offscreen document, an offscreen transcription queue that writes segments to IndexedDB and broadcasts them, and a side panel that renders them live. The Phase 2 capture path is untouched except for enqueueing each saved chunk into the queue.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (shared), WXT + Preact (extension), Chrome MV3 (`offscreen`, `sidePanel`, `optional_host_permissions`), IndexedDB.

**Spec:** `docs/superpowers/specs/2026-08-26-scribetab-design.md` (see also roadmap `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md`, Phase 3 section — the locked `TranscriptionProvider` / `TranscribeRequest` / `TranscribeResult` / `TranscriptSegment` / `ProviderConfig` types already exist verbatim in `packages/shared/src/types.ts` and MUST NOT change).

## Global Constraints

- Privacy invariants (spec §"Non-negotiable product contract"): API keys go in `chrome.storage.local` ONLY — never `chrome.storage.sync`, never any server. The only network traffic is the call to the endpoint the user configured. No telemetry.
- `minimum_chrome_version: '116'` (already in `apps/extension/wxt.config.ts`) — every API used must exist at 116 (`chrome.sidePanel.open` is 116+, OK).
- Node ≥ 20, pnpm 9 (`packageManager: pnpm@9.15.0`).
- License GPL-3.0-only; every new `package.json` field stays as-is.
- Locked types in `packages/shared/src/types.ts` are consumed verbatim; changing them requires a roadmap update (do not).
- TDD for everything in `packages/shared`. Extension glue code has no unit-test harness (matches Phase 2 precedent — `apps/extension` test script is a placeholder); it is verified by `pnpm typecheck` + `pnpm build` and the manual milestone checklist in the final task.
- Offscreen documents can only use `chrome.runtime` — no `chrome.storage` there. All settings reach the offscreen doc inside the `OFFSCREEN_START` message; all state writes go through the service worker (existing pattern in `entrypoints/offscreen/main.ts` → `notifyBackground`).
- Segment timing is **session-relative ms** (locked comment on `TranscriptSegment`): chunk producers must add the chunk's session offset to any provider-relative timestamps.
- Retry policy (roadmap): exponential backoff 1 s / 4 s / 16 s, then a gap segment with text `[transcription failed]` — never silent loss.
- Commit after every task. Do not merge to `main` mid-phase if working on a branch; follow whatever branch you were started on.

---

### Task 1: OpenAI-compatible adapter factory + openai/groq/mistral/custom adapters

Four of the five providers speak the same multipart `POST {base}/audio/transcriptions` dialect; implement one factory and four thin instances (DRY, and it IS the local-model story — whisper.cpp server, Speaches, LM Studio are all `custom` with a `baseUrl`).

**Files:**
- Create: `packages/shared/src/providers/openaiCompatible.ts`
- Create: `packages/shared/src/providers/openai.ts`
- Create: `packages/shared/src/providers/groq.ts`
- Create: `packages/shared/src/providers/mistral.ts`
- Create: `packages/shared/src/providers/custom.ts`
- Test: `packages/shared/test/openaiCompatible.test.ts`

**Interfaces:**
- Consumes: `TranscriptionProvider`, `TranscribeRequest`, `TranscribeResult`, `ProviderConfig` from `packages/shared/src/types.ts` (existing).
- Produces: `openAiCompatible(opts: OpenAiCompatibleOptions): TranscriptionProvider`; exported consts `openaiProvider`, `groqProvider`, `mistralProvider`, `customProvider` (each a `TranscriptionProvider`). Task 3 registers them; Task 10 calls `.transcribe()`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/openaiCompatible.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAiCompatible } from '../src/providers/openaiCompatible';
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — cannot resolve `../src/providers/openaiCompatible`.

- [ ] **Step 3: Implement factory and adapters**

```ts
// packages/shared/src/providers/openaiCompatible.ts
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types';

export interface OpenAiCompatibleOptions {
  id: string;
  defaultBaseUrl?: string;   // absent → cfg.baseUrl is required (custom/localhost)
  defaultModel: string;
  requiresApiKey?: boolean;  // default true; false for localhost servers
  form?: Record<string, string>; // extra multipart fields (response_format, …)
}

interface VerboseJson {
  text?: string;
  segments?: { start: number; end: number; text: string }[];
}

const TIMEOUT_MS = 120_000;

/**
 * Builds a TranscriptionProvider for any endpoint speaking the OpenAI
 * `POST {base}/audio/transcriptions` multipart dialect. This includes the
 * local-model path: whisper.cpp server, Speaches/faster-whisper, LM Studio.
 */
export function openAiCompatible(opts: OpenAiCompatibleOptions): TranscriptionProvider {
  return {
    id: opts.id,
    async transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult> {
      const baseUrl = (cfg.baseUrl ?? opts.defaultBaseUrl)?.replace(/\/+$/, '');
      if (!baseUrl) throw new Error(`${opts.id}: baseUrl is required`);
      if ((opts.requiresApiKey ?? true) && !cfg.apiKey) {
        throw new Error(`${opts.id}: apiKey is required`);
      }

      const form = new FormData();
      form.append('file', new Blob([req.audio], { type: req.mimeType }), 'audio.wav');
      form.append('model', cfg.model ?? opts.defaultModel);
      for (const [k, v] of Object.entries(opts.form ?? {})) form.append(k, v);
      if (req.language) form.append('language', req.language);

      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`${opts.id}: HTTP ${res.status} ${body}`);
      }
      const json = (await res.json()) as VerboseJson;
      return {
        text: json.text ?? '',
        segments: json.segments?.map((s) => ({
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(s.end * 1000),
          text: s.text,
        })),
      };
    },
  };
}
```

```ts
// packages/shared/src/providers/openai.ts
import { openAiCompatible } from './openaiCompatible';

export const openaiProvider = openAiCompatible({
  id: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'whisper-1',
  form: { response_format: 'verbose_json' },
});
```

```ts
// packages/shared/src/providers/groq.ts
import { openAiCompatible } from './openaiCompatible';

export const groqProvider = openAiCompatible({
  id: 'groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'whisper-large-v3-turbo',
  form: { response_format: 'verbose_json' },
});
```

```ts
// packages/shared/src/providers/mistral.ts
import { openAiCompatible } from './openaiCompatible';

// Voxtral speaks the OpenAI multipart dialect but takes
// timestamp_granularities=segment instead of response_format=verbose_json.
export const mistralProvider = openAiCompatible({
  id: 'mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'voxtral-mini-latest',
  form: { timestamp_granularities: 'segment' },
});
```

```ts
// packages/shared/src/providers/custom.ts
import { openAiCompatible } from './openaiCompatible';

// The local-model story: any OpenAI-compatible server (whisper.cpp server,
// Speaches, LM Studio) on a user-supplied baseUrl. No response_format extra
// field: plain `json` is the lowest common denominator across local servers;
// chunks then fall back to one segment per chunk, which is fine for live view.
export const customProvider = openAiCompatible({
  id: 'custom',
  defaultModel: 'whisper-1', // many local servers ignore the field; OpenAI dialect requires it
  requiresApiKey: false,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @scribetab/shared test`
Expected: PASS (existing `chunker.test.ts`, `wav.test.ts` still green).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/providers packages/shared/test/openaiCompatible.test.ts
git commit -m "feat(shared): OpenAI-compatible transcription adapters (openai, groq, mistral, custom)"
```

---

### Task 2: Deepgram adapter

Deepgram is the one genuinely different dialect: raw audio body, `Token` auth, query-string options, utterances → segments.

**Files:**
- Create: `packages/shared/src/providers/deepgram.ts`
- Test: `packages/shared/test/deepgram.test.ts`

**Interfaces:**
- Consumes: locked types from `../types` (as Task 1).
- Produces: `deepgramProvider: TranscriptionProvider`. Task 3 registers it.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/deepgram.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — cannot resolve `../src/providers/deepgram`.

- [ ] **Step 3: Implement the adapter**

```ts
// packages/shared/src/providers/deepgram.ts
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types';

interface DeepgramResponse {
  results?: {
    channels?: { alternatives?: { transcript?: string }[] }[];
    utterances?: { start: number; end: number; transcript: string }[];
  };
}

const TIMEOUT_MS = 120_000;

export const deepgramProvider: TranscriptionProvider = {
  id: 'deepgram',
  async transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult> {
    if (!cfg.apiKey) throw new Error('deepgram: apiKey is required');
    const base = (cfg.baseUrl ?? 'https://api.deepgram.com').replace(/\/+$/, '');
    const params = new URLSearchParams({
      model: cfg.model ?? 'nova-2',
      smart_format: 'true',
      utterances: 'true',
    });
    if (req.language) params.set('language', req.language);

    const res = await fetch(`${base}/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${cfg.apiKey}`, 'Content-Type': req.mimeType },
      body: req.audio,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`deepgram: HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as DeepgramResponse;
    return {
      text: json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '',
      segments: json.results?.utterances?.map((u) => ({
        startMs: Math.round(u.start * 1000),
        endMs: Math.round(u.end * 1000),
        text: u.transcript,
      })),
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @scribetab/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/providers/deepgram.ts packages/shared/test/deepgram.test.ts
git commit -m "feat(shared): Deepgram transcription adapter"
```

---

### Task 3: Provider registry + endpoint helper + shared exports

**Files:**
- Create: `packages/shared/src/providers/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/providersRegistry.test.ts`

**Interfaces:**
- Consumes: the five provider consts from Tasks 1–2.
- Produces:
  - `getTranscriptionProvider(id: string): TranscriptionProvider` (throws on unknown id) — used by Task 10 (offscreen).
  - `transcriptionEndpoint(providerId: string, baseUrl?: string): string` — resolves the URL the extension must hold host permission for; used by Tasks 8 (options) and 9 (SW).
  - `TRANSCRIPTION_PROVIDER_IDS: readonly string[]` — used by Task 8's provider `<select>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/providersRegistry.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPTION_PROVIDER_IDS,
  getTranscriptionProvider,
  transcriptionEndpoint,
} from '../src/providers';

describe('provider registry', () => {
  it('exposes the five v1 provider ids', () => {
    expect([...TRANSCRIPTION_PROVIDER_IDS].sort()).toEqual(
      ['custom', 'deepgram', 'groq', 'mistral', 'openai'],
    );
  });

  it('returns the matching provider', () => {
    expect(getTranscriptionProvider('groq').id).toBe('groq');
  });

  it('throws on unknown id', () => {
    expect(() => getTranscriptionProvider('nope')).toThrow(/Unknown transcription provider: nope/);
  });
});

describe('transcriptionEndpoint', () => {
  it('returns the provider default base url', () => {
    expect(transcriptionEndpoint('openai')).toBe('https://api.openai.com/v1');
    expect(transcriptionEndpoint('deepgram')).toBe('https://api.deepgram.com');
  });

  it('prefers an explicit baseUrl', () => {
    expect(transcriptionEndpoint('openai', 'http://localhost:9000/v1')).toBe('http://localhost:9000/v1');
  });

  it('throws for custom without baseUrl', () => {
    expect(() => transcriptionEndpoint('custom')).toThrow(/custom: baseUrl is required/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — cannot resolve `../src/providers`.

- [ ] **Step 3: Implement registry and export from the package root**

```ts
// packages/shared/src/providers/index.ts
import type { TranscriptionProvider } from '../types';
import { customProvider } from './custom';
import { deepgramProvider } from './deepgram';
import { groqProvider } from './groq';
import { mistralProvider } from './mistral';
import { openaiProvider } from './openai';

const providers: Record<string, TranscriptionProvider> = {
  openai: openaiProvider,
  groq: groqProvider,
  deepgram: deepgramProvider,
  mistral: mistralProvider,
  custom: customProvider,
};

export const TRANSCRIPTION_PROVIDER_IDS = Object.freeze(Object.keys(providers));

export function getTranscriptionProvider(id: string): TranscriptionProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown transcription provider: ${id}`);
  return p;
}

/** Where a config will actually send audio — the origin the extension must hold host permission for. */
const defaultBaseUrls: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepgram: 'https://api.deepgram.com',
  mistral: 'https://api.mistral.ai/v1',
  custom: undefined,
};

export function transcriptionEndpoint(providerId: string, baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  const d = defaultBaseUrls[providerId];
  if (!d) throw new Error(`${providerId}: baseUrl is required`);
  return d;
}

export { customProvider, deepgramProvider, groqProvider, mistralProvider, openaiProvider };
export { openAiCompatible } from './openaiCompatible';
```

Append to `packages/shared/src/index.ts` (keep existing lines):

```ts
export * from './providers';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @scribetab/shared test && pnpm --filter @scribetab/shared typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/providers/index.ts packages/shared/src/index.ts packages/shared/test/providersRegistry.test.ts
git commit -m "feat(shared): transcription provider registry and endpoint resolver"
```

---

### Task 4: `originPattern` — Chrome match pattern from an endpoint URL

`chrome.permissions.request` takes match patterns, not URLs. Match patterns must not carry a port (a granted `http://localhost/*` covers every port) and must not carry a path.

**Files:**
- Create: `packages/shared/src/originPattern.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/originPattern.test.ts`

**Interfaces:**
- Produces: `originPattern(url: string): string` — used by Task 8 (options page `permissions.request`) and Task 9 (SW `permissions.contains`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/originPattern.test.ts
import { describe, expect, it } from 'vitest';
import { originPattern } from '../src/originPattern';

describe('originPattern', () => {
  it('turns an https endpoint into a host match pattern', () => {
    expect(originPattern('https://api.openai.com/v1')).toBe('https://api.openai.com/*');
  });

  it('drops ports — match patterns cover all ports of a host', () => {
    expect(originPattern('http://localhost:8080/v1')).toBe('http://localhost/*');
    expect(originPattern('http://127.0.0.1:9000')).toBe('http://127.0.0.1/*');
  });

  it('drops paths and query strings', () => {
    expect(originPattern('https://api.deepgram.com/v1/listen?model=nova-2')).toBe('https://api.deepgram.com/*');
  });

  it('rejects non-http(s) schemes and garbage', () => {
    expect(() => originPattern('ftp://example.com')).toThrow(/http/);
    expect(() => originPattern('not a url')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — cannot resolve `../src/originPattern`.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/originPattern.ts
/**
 * Chrome extension match pattern for the origin of an endpoint URL.
 * Match patterns cannot carry a port; a grant covers all ports on the host.
 */
export function originPattern(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`originPattern: only http(s) endpoints are supported, got ${u.protocol}`);
  }
  return `${u.protocol}//${u.hostname}/*`;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './originPattern';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @scribetab/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/originPattern.ts packages/shared/src/index.ts packages/shared/test/originPattern.test.ts
git commit -m "feat(shared): originPattern helper for optional host permission grants"
```

---

### Task 5: TranscriptionQueue — serialized jobs, backoff, gap segments, cancel

The heart of Phase 3. Pure and fully injectable (transcribe fn, sleep, id maker) so every path is unit-testable without timers or network.

**Files:**
- Create: `packages/shared/src/transcriptionQueue.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `TranscribeRequest`, `TranscribeResult`, `TranscriptSegment` from `./types`.
- Produces (used verbatim by Task 10):

```ts
export interface TranscriptionJob {
  index: number;       // chunk index (ordering / diagnostics)
  wav: ArrayBuffer;    // encoded WAV for this chunk
  startMs: number;     // session-relative start of this chunk
  durationMs: number;  // chunk duration
}
export interface TranscriptionQueueOptions {
  sessionId: string;
  transcribe: (req: TranscribeRequest) => Promise<TranscribeResult>;
  onSegments: (segments: TranscriptSegment[]) => void | Promise<void>;
  language?: string;
  retryDelaysMs?: number[];         // default [1000, 4000, 16000]
  sleep?: (ms: number) => Promise<void>;
  makeId?: () => string;            // default crypto.randomUUID
}
export const FAILED_SEGMENT_TEXT = '[transcription failed]';
export class TranscriptionQueue {
  constructor(opts: TranscriptionQueueOptions);
  enqueue(job: TranscriptionJob): void;   // serialized FIFO; never rejects
  drain(): Promise<void>;                 // resolves when all enqueued jobs settled
  cancel(): void;                         // stop retrying + suppress further onSegments
}
export function segmentsFromResult(
  result: TranscribeResult, job: TranscriptionJob, sessionId: string, makeId: () => string,
): TranscriptSegment[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/transcriptionQueue.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  FAILED_SEGMENT_TEXT,
  TranscriptionQueue,
  segmentsFromResult,
} from '../src/transcriptionQueue';
import type { TranscriptSegment } from '../src/types';

const job = (index: number, startMs = index * 45_000): { index: number; wav: ArrayBuffer; startMs: number; durationMs: number } =>
  ({ index, wav: new ArrayBuffer(4), startMs, durationMs: 45_000 });

let n = 0;
const ids = () => `id-${n++}`;

describe('segmentsFromResult', () => {
  it('offsets provider segments by the chunk start and trims empties', () => {
    const segs = segmentsFromResult(
      { text: 'x', segments: [
        { startMs: 0, endMs: 1000, text: ' hello ' },
        { startMs: 1000, endMs: 2000, text: '   ' },
      ] },
      job(2, 90_000), 's1', ids,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      sessionId: 's1', startMs: 90_000, endMs: 91_000, text: 'hello', source: 'audio',
    });
  });

  it('falls back to one whole-chunk segment when the provider returns only text', () => {
    const segs = segmentsFromResult({ text: ' just text ' }, job(0), 's1', ids);
    expect(segs).toEqual([expect.objectContaining({
      startMs: 0, endMs: 45_000, text: 'just text', source: 'audio',
    })]);
  });

  it('returns nothing for silent chunks (empty text, no segments)', () => {
    expect(segmentsFromResult({ text: '  ' }, job(0), 's1', ids)).toEqual([]);
  });
});

describe('TranscriptionQueue', () => {
  it('transcribes a job and delivers mapped segments', async () => {
    const got: TranscriptSegment[][] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'hi' }),
      onSegments: (s) => { got.push(s); },
      makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(got).toHaveLength(1);
    expect(got[0]![0]!.text).toBe('hi');
  });

  it('passes the language hint through', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: 'x' });
    const q = new TranscriptionQueue({
      sessionId: 's1', transcribe, onSegments: () => {}, language: 'sv', makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/wav', language: 'sv' }),
    );
  });

  it('retries with 1s/4s/16s backoff then succeeds', async () => {
    const delays: number[] = [];
    const transcribe = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ text: 'third time' });
    const got: TranscriptSegment[][] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1', transcribe,
      onSegments: (s) => { got.push(s); },
      sleep: async (ms) => { delays.push(ms); },
      makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(delays).toEqual([1000, 4000]);
    expect(got[0]![0]!.text).toBe('third time');
  });

  it('emits a gap segment after all retries fail — never silent loss', async () => {
    const delays: number[] = [];
    const got: TranscriptSegment[][] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockRejectedValue(new Error('down')),
      onSegments: (s) => { got.push(s); },
      sleep: async (ms) => { delays.push(ms); },
      makeId: ids,
    });
    q.enqueue(job(3, 135_000));
    await q.drain();
    expect(delays).toEqual([1000, 4000, 16000]);
    expect(got[0]).toEqual([expect.objectContaining({
      text: FAILED_SEGMENT_TEXT, startMs: 135_000, endMs: 180_000, source: 'audio',
    })]);
  });

  it('processes jobs strictly in order', async () => {
    const order: number[] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: async (req) => {
        // first job is slow — order must still hold
        if (req.audio.byteLength === 8) await new Promise((r) => setTimeout(r, 20));
        return { text: String(req.audio.byteLength) };
      },
      onSegments: (s) => { order.push(Number(s[0]!.text)); },
      makeId: ids,
    });
    q.enqueue({ index: 0, wav: new ArrayBuffer(8), startMs: 0, durationMs: 1000 });
    q.enqueue({ index: 1, wav: new ArrayBuffer(4), startMs: 1000, durationMs: 1000 });
    await q.drain();
    expect(order).toEqual([8, 4]);
  });

  it('a throwing onSegments does not break later jobs', async () => {
    const got: string[] = [];
    let first = true;
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
      onSegments: () => {
        if (first) { first = false; throw new Error('idb full'); }
        got.push('delivered');
      },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(got).toEqual(['delivered']);
  });

  it('cancel() stops retrying and suppresses delivery', async () => {
    const onSegments = vi.fn();
    let sleeps = 0;
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockRejectedValue(new Error('down')),
      onSegments,
      sleep: async () => { sleeps++; q.cancel(); },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(sleeps).toBe(1);            // cancelled during first backoff
    expect(onSegments).not.toHaveBeenCalled(); // no gap segment either — session was abandoned
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — cannot resolve `../src/transcriptionQueue`.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/transcriptionQueue.ts
import type { TranscribeRequest, TranscribeResult, TranscriptSegment } from './types';

export interface TranscriptionJob {
  index: number;
  wav: ArrayBuffer;
  startMs: number;
  durationMs: number;
}

export interface TranscriptionQueueOptions {
  sessionId: string;
  transcribe: (req: TranscribeRequest) => Promise<TranscribeResult>;
  onSegments: (segments: TranscriptSegment[]) => void | Promise<void>;
  language?: string;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  makeId?: () => string;
}

export const FAILED_SEGMENT_TEXT = '[transcription failed]';
const DEFAULT_DELAYS = [1000, 4000, 16000];

export function segmentsFromResult(
  result: TranscribeResult,
  job: TranscriptionJob,
  sessionId: string,
  makeId: () => string,
): TranscriptSegment[] {
  if (result.segments && result.segments.length > 0) {
    return result.segments
      .filter((s) => s.text.trim().length > 0)
      .map((s) => ({
        id: makeId(),
        sessionId,
        startMs: job.startMs + s.startMs,
        endMs: job.startMs + s.endMs,
        text: s.text.trim(),
        source: 'audio' as const,
      }));
  }
  const text = result.text.trim();
  if (!text) return [];
  return [{
    id: makeId(),
    sessionId,
    startMs: job.startMs,
    endMs: job.startMs + job.durationMs,
    text,
    source: 'audio' as const,
  }];
}

/**
 * Serialized FIFO transcription pipeline: one chunk in flight at a time (keeps
 * segment delivery ordered and providers un-hammered), exponential backoff per
 * chunk, and a marked gap segment after final failure — a flaky network means
 * "transcript arrives late", never "audio lost" silently.
 */
export class TranscriptionQueue {
  private chain: Promise<void> = Promise.resolve();
  private cancelled = false;

  constructor(private opts: TranscriptionQueueOptions) {}

  enqueue(job: TranscriptionJob): void {
    this.chain = this.chain.then(() => this.process(job)).catch(() => {});
  }

  drain(): Promise<void> {
    return this.chain;
  }

  /** Abandon the session: stop retrying, deliver nothing further. */
  cancel(): void {
    this.cancelled = true;
  }

  private async process(job: TranscriptionJob): Promise<void> {
    if (this.cancelled) return;
    const delays = this.opts.retryDelaysMs ?? DEFAULT_DELAYS;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const makeId = this.opts.makeId ?? (() => crypto.randomUUID());

    let result: TranscribeResult | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await this.opts.transcribe({
          audio: job.wav,
          mimeType: 'audio/wav',
          language: this.opts.language,
        });
        break;
      } catch {
        if (this.cancelled || attempt >= delays.length) break;
        await sleep(delays[attempt]!);
        if (this.cancelled) break;
      }
    }
    if (this.cancelled) return;

    const segments = result
      ? segmentsFromResult(result, job, this.opts.sessionId, makeId)
      : [{
          id: makeId(),
          sessionId: this.opts.sessionId,
          startMs: job.startMs,
          endMs: job.startMs + job.durationMs,
          text: FAILED_SEGMENT_TEXT,
          source: 'audio' as const,
        }];
    if (segments.length > 0) await this.opts.onSegments(segments);
  }
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './transcriptionQueue';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @scribetab/shared test && pnpm --filter @scribetab/shared typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/transcriptionQueue.ts packages/shared/src/index.ts packages/shared/test/transcriptionQueue.test.ts
git commit -m "feat(shared): TranscriptionQueue with backoff, gap segments, cancel"
```

---

### Task 6: Extension settings module, message types, manifest permissions

Glue task (no unit harness in the extension — verified by typecheck + build).

**Files:**
- Create: `apps/extension/utils/settings.ts`
- Modify: `apps/extension/utils/messages.ts`
- Modify: `apps/extension/wxt.config.ts`

**Interfaces:**
- Produces:
  - `Settings`, `DEFAULT_SETTINGS`, `getSettings(): Promise<Settings>`, `saveSettings(s: Settings): Promise<void>` — used by Tasks 8, 9.
  - `TranscriptionSettingsPayload` and the widened `ToOffscreen` / `ToBackground` / `ToSidePanel` message types — used by Tasks 9, 10, 11, 12.
  - Manifest gains `sidePanel` permission and `optional_host_permissions`.

- [ ] **Step 1: Write the settings module**

```ts
// apps/extension/utils/settings.ts
export interface Settings {
  providerId: '' | 'openai' | 'groq' | 'deepgram' | 'mistral' | 'custom';
  apiKey: string;      // chrome.storage.local ONLY — never sync, never any server
  model: string;       // '' = provider default
  language: string;    // '' = provider auto-detect; BCP-47 hint otherwise
  baseUrl: string;     // custom provider only
  micEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  providerId: '',
  apiKey: '',
  model: '',
  language: '',
  baseUrl: '',
  micEnabled: false,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((v[KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}
```

- [ ] **Step 2: Extend the message types**

Replace the whole of `apps/extension/utils/messages.ts` with:

```ts
import type { TranscriptSegment } from '@scribetab/shared';

export type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping';

/** What the offscreen doc needs to run transcription (it has no chrome.storage). */
export interface TranscriptionSettingsPayload {
  providerId: string;
  apiKey: string;
  model?: string;
  language?: string;
  baseUrl?: string;
}

/** Messages handled by the service worker (from popup or offscreen). */
export type ToBackground =
  | { target: 'background'; type: 'START_CAPTURE' }
  | { target: 'background'; type: 'STOP_CAPTURE' }
  | { target: 'background'; type: 'CHUNK_SAVED'; count: number }      // offscreen → SW
  | { target: 'background'; type: 'SEGMENT_SAVED'; count: number }    // offscreen → SW (running total)
  | { target: 'background'; type: 'MIC_STATUS'; status: 'active' | 'denied' | 'off' } // offscreen → SW
  | { target: 'background'; type: 'CAPTURE_ENDED'; reason: string; error?: string };  // offscreen → SW

/** Messages handled by the offscreen document (from the service worker only). */
export type ToOffscreen =
  | {
      target: 'offscreen';
      type: 'OFFSCREEN_START';
      streamId: string;
      sessionId: string;
      transcription: TranscriptionSettingsPayload | null; // null = record only, no STT configured
      micEnabled: boolean;
    }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP' };

/** Broadcast to the side panel (from the offscreen document). */
export type ToSidePanel = {
  target: 'sidepanel';
  type: 'SEGMENTS_ADDED';
  sessionId: string;
  segments: TranscriptSegment[];
};

export interface Ack {
  ok: boolean;
  error?: string;
}
```

- [ ] **Step 3: Add manifest permissions**

In `apps/extension/wxt.config.ts` replace the `manifest` object with:

```ts
  manifest: {
    name: 'ScribeTab',
    description:
      'BYOK meeting transcriber. Captures tab audio locally — no bot, no cloud storage.',
    permissions: ['tabCapture', 'offscreen', 'storage', 'downloads', 'activeTab', 'sidePanel'],
    // Granted per-origin from the options page (chrome.permissions.request)
    // for exactly the STT endpoint the user configures — cloud or localhost.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    minimum_chrome_version: '116',
  },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @scribetab/extension typecheck`
Expected: PASS. (`entrypoints/background.ts` still compiles because `ToBackground` only gained union members; `OFFSCREEN_START` senders/receivers are updated in Tasks 9–10 — if the stricter `ToOffscreen` breaks `background.ts` compilation NOW, that is expected: fix it in this step by adding the new fields at the existing call site with placeholder values `sessionId: crypto.randomUUID(), transcription: null, micEnabled: false`, which Task 9 replaces with the real plumbing.)

- [ ] **Step 5: Commit**

```bash
git add apps/extension/utils/settings.ts apps/extension/utils/messages.ts apps/extension/wxt.config.ts apps/extension/entrypoints/background.ts
git commit -m "feat(extension): settings module, transcription message types, sidePanel + optional host permissions"
```

---

### Task 7: IndexedDB v2 — shared `openDb` + segments store

Both stores live in the one `scribetab` DB. Extract the memoized connection (currently private to `chunkStore.ts`) into `utils/db.ts`, bump to version 2, add the `segments` store. The existing memo/`onversionchange` code was audit-hardened — move it verbatim, do not rewrite it.

**Files:**
- Create: `apps/extension/utils/db.ts`
- Create: `apps/extension/utils/segmentStore.ts`
- Modify: `apps/extension/utils/chunkStore.ts`

**Interfaces:**
- Produces:
  - `openDb(): Promise<IDBDatabase>`, `CHUNKS_STORE`, `SEGMENTS_STORE` from `db.ts`.
  - `putSegments(segments: TranscriptSegment[]): Promise<void>`, `getSegments(sessionId: string): Promise<TranscriptSegment[]>`, `clearSegments(): Promise<void>` from `segmentStore.ts` — used by Tasks 10 (offscreen writes) and 11 (side panel reads).
- Consumes: `TranscriptSegment` from `@scribetab/shared`.

- [ ] **Step 1: Create `db.ts`**

```ts
// apps/extension/utils/db.ts
const DB_NAME = 'scribetab';
const DB_VERSION = 2; // v1: audioChunks. v2: + segments.
export const CHUNKS_STORE = 'audioChunks';
export const SEGMENTS_STORE = 'segments';

// Memoized: opening a connection per operation leaked one IDBDatabase per
// chunk (~80/hour meeting), and any lingering open connection would block a
// future onupgradeneeded (e.g. Phase 4's sessions re-key). onversionchange
// closes the memoized connection and clears the memo so the next call
// reopens against the new version instead of hanging as 'blocked'.
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE, { keyPath: 'index' });
        }
        if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
          const store = db.createObjectStore(SEGMENTS_STORE, { keyPath: 'id' });
          store.createIndex('bySession', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}
```

- [ ] **Step 2: Rewire `chunkStore.ts` onto it**

Delete everything from `const DB_NAME = 'scribetab';` through the end of `openDb` in `apps/extension/utils/chunkStore.ts` (lines 9–47) and replace with:

```ts
import { CHUNKS_STORE as STORE, openDb } from './db';
```

The `ChunkRow` interface and the three exported functions (`putChunk`, `getAllChunks`, `clearChunks`) stay byte-identical — they already reference `STORE` and `openDb()`.

- [ ] **Step 3: Create `segmentStore.ts`**

```ts
// apps/extension/utils/segmentStore.ts
import type { TranscriptSegment } from '@scribetab/shared';
import { SEGMENTS_STORE as STORE, openDb } from './db';

export async function putSegments(segments: TranscriptSegment[]): Promise<void> {
  if (segments.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const s of segments) store.put(s);
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function getSegments(sessionId: string): Promise<TranscriptSegment[]> {
  const db = await openDb();
  const rows = await new Promise<TranscriptSegment[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('bySession').getAll(sessionId);
    req.onsuccess = () => resolve(req.result as TranscriptSegment[]);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return rows.sort((a, b) => a.startMs - b.startMs);
}

export async function clearSegments(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @scribetab/extension typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/utils/db.ts apps/extension/utils/chunkStore.ts apps/extension/utils/segmentStore.ts
git commit -m "feat(extension): IndexedDB v2 with segments store behind shared openDb"
```

---

### Task 8: Options page — provider config, masked key, host-permission grant

**Files:**
- Create: `apps/extension/entrypoints/options/index.html`
- Create: `apps/extension/entrypoints/options/main.tsx`

WXT auto-registers an `options/` entrypoint as the MV3 `options_ui` page.

**Interfaces:**
- Consumes: `Settings`/`getSettings`/`saveSettings` (Task 6), `TRANSCRIPTION_PROVIDER_IDS`, `transcriptionEndpoint`, `originPattern` (Tasks 3–4).
- Produces: a saved `Settings` object in `chrome.storage.local` and a granted host permission for the endpoint origin — Task 9 reads both.

- [ ] **Step 1: Create the HTML shell**

```html
<!-- apps/extension/entrypoints/options/index.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ScribeTab settings</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the options UI**

```tsx
// apps/extension/entrypoints/options/main.tsx
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  TRANSCRIPTION_PROVIDER_IDS,
  originPattern,
  transcriptionEndpoint,
} from '@scribetab/shared';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '@/utils/settings';

const MODEL_PLACEHOLDERS: Record<string, string> = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
  deepgram: 'nova-2',
  mistral: 'voxtral-mini-latest',
  custom: 'whisper-1',
};

function App() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    void getSettings().then(setS);
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setStatus(null);
    try {
      if (s.providerId === '') {
        // No provider = record-only mode; still a valid save.
        await saveSettings(s);
        setStatus({ kind: 'ok', text: 'Saved. Transcription is off (no provider chosen).' });
        return;
      }
      if (s.providerId === 'custom' && !s.baseUrl.trim()) {
        throw new Error('Custom provider needs a base URL (e.g. http://localhost:8080/v1)');
      }
      const endpoint = transcriptionEndpoint(s.providerId, s.baseUrl.trim() || undefined);
      const origin = originPattern(endpoint);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`Permission for ${origin} was declined — transcription cannot reach the endpoint`);
      await saveSettings({ ...s, baseUrl: s.baseUrl.trim() });
      setStatus({ kind: 'ok', text: `Saved. Access granted for ${origin}` });
    } catch (e) {
      setStatus({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const row = { display: 'block', margin: '12px 0 4px', fontWeight: 600 } as const;
  const input = { width: '100%', maxWidth: 420, padding: 6 } as const;

  return (
    <main style={{ maxWidth: 560, margin: '24px auto', padding: 16, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>ScribeTab settings</h1>
      <p style={{ color: '#555', fontSize: 13 }}>
        Bring your own key. Keys are stored only in this browser profile
        (<code>chrome.storage.local</code>) and are sent only to the endpoint you configure.
      </p>

      <label style={row} for="provider">Transcription provider</label>
      <select
        id="provider"
        style={input}
        value={s.providerId}
        onChange={(e) => set('providerId', (e.currentTarget as HTMLSelectElement).value as Settings['providerId'])}
      >
        <option value="">Off (record only)</option>
        {TRANSCRIPTION_PROVIDER_IDS.map((id) => (
          <option value={id}>{id === 'custom' ? 'custom (OpenAI-compatible / local server)' : id}</option>
        ))}
      </select>

      {s.providerId !== '' && (
        <>
          {s.providerId === 'custom' && (
            <>
              <label style={row} for="baseUrl">Base URL</label>
              <input
                id="baseUrl"
                style={input}
                placeholder="http://localhost:8080/v1"
                value={s.baseUrl}
                onInput={(e) => set('baseUrl', (e.currentTarget as HTMLInputElement).value)}
              />
            </>
          )}

          <label style={row} for="apiKey">API key {s.providerId === 'custom' && '(optional for local servers)'}</label>
          <input
            id="apiKey"
            type="password"
            autocomplete="off"
            style={input}
            value={s.apiKey}
            onInput={(e) => set('apiKey', (e.currentTarget as HTMLInputElement).value)}
          />

          <label style={row} for="model">Model (blank = default)</label>
          <input
            id="model"
            style={input}
            placeholder={MODEL_PLACEHOLDERS[s.providerId] ?? ''}
            value={s.model}
            onInput={(e) => set('model', (e.currentTarget as HTMLInputElement).value)}
          />

          <label style={row} for="language">Language hint (blank = auto, e.g. "en", "sv")</label>
          <input
            id="language"
            style={input}
            value={s.language}
            onInput={(e) => set('language', (e.currentTarget as HTMLInputElement).value)}
          />
        </>
      )}

      <label style={{ ...row, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.micEnabled}
          onChange={(e) => set('micEnabled', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Mix in my microphone (echo-cancelled; falls back to tab-only if denied)
      </label>

      <div style={{ marginTop: 16 }}>
        <button onClick={() => void save()}>Save</button>
      </div>
      {status && (
        <p style={{ color: status.kind === 'ok' ? 'green' : 'crimson', fontSize: 13 }}>{status.text}</p>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @scribetab/extension typecheck && pnpm --filter @scribetab/extension build`
Expected: PASS; build output lists an `options` entrypoint and the manifest contains `options_ui`.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/options
git commit -m "feat(extension): options page with provider config and host-permission grant"
```

---

### Task 9: Service worker — session id + settings plumbing into OFFSCREEN_START

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: `getSettings` (Task 6), `transcriptionEndpoint`, `originPattern` (shared), widened message types (Task 6).
- Produces: `OFFSCREEN_START` messages carrying `{ streamId, sessionId, transcription, micEnabled }`; storage keys `currentSessionId` (string), `segmentCount` (number), `micStatus` ('active' | 'denied' | 'off'), `transcriptionConfigured` (boolean) — read by Tasks 10–12.

- [ ] **Step 1: Build the start payload**

In `background.ts`, add imports at the top:

```ts
import { originPattern, transcriptionEndpoint } from '@scribetab/shared';
import { getSettings } from '@/utils/settings';
import type { TranscriptionSettingsPayload } from '@/utils/messages';
```

Add above `handleStart`:

```ts
/**
 * null when transcription is off or unusable (unconfigured, missing key for a
 * cloud provider, or the host permission was never granted). Recording still
 * proceeds — transcription is an overlay on capture, not a precondition.
 */
async function transcriptionPayload(): Promise<TranscriptionSettingsPayload | null> {
  const s = await getSettings();
  if (s.providerId === '') return null;
  let endpoint: string;
  try {
    endpoint = transcriptionEndpoint(s.providerId, s.baseUrl || undefined);
  } catch {
    return null; // custom without baseUrl
  }
  if (s.providerId !== 'custom' && !s.apiKey) return null;
  const granted = await chrome.permissions.contains({ origins: [originPattern(endpoint)] });
  if (!granted) return null;
  return {
    providerId: s.providerId,
    apiKey: s.apiKey,
    model: s.model || undefined,
    language: s.language || undefined,
    baseUrl: s.baseUrl || undefined,
  };
}
```

- [ ] **Step 2: Wire it into `handleStart`**

Inside `handleStart`, after the `streamId` line and before the first `sendToOffscreen` call, insert:

```ts
    const settings = await getSettings();
    const transcription = await transcriptionPayload();
    const sessionId = crypto.randomUUID();
    const startMsg = {
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      streamId,
      sessionId,
      transcription,
      micEnabled: settings.micEnabled,
    } as const;
```

Replace both `sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_START', streamId })` call sites with `sendToOffscreen(startMsg)` (the retry after "already running" reuses the same message — the stream id is still the fresh one).

Extend the success `chrome.storage.local.set` at the end of `handleStart` to:

```ts
    await chrome.storage.local.set({
      captureState: 'recording',
      chunkCount: 0,
      segmentCount: 0,
      currentSessionId: sessionId,
      transcriptionConfigured: transcription !== null,
      micStatus: settings.micEnabled ? 'active' : 'off', // corrected by MIC_STATUS if denied
      capturedTabId: tab.id,
      lastError: null,
    });
```

- [ ] **Step 3: Handle the new offscreen → SW messages**

In the `onMessage` switch, add two cases next to `CHUNK_SAVED`:

```ts
        case 'SEGMENT_SAVED':
          await chrome.storage.local.set({ segmentCount: msg.count });
          sendResponse({ ok: true });
          break;
        case 'MIC_STATUS':
          await chrome.storage.local.set({ micStatus: msg.status });
          sendResponse({ ok: true });
          break;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @scribetab/extension typecheck`
Expected: FAIL only in `entrypoints/offscreen/main.ts` if its `OFFSCREEN_START` handler signature hasn't caught up (it destructures the message in Task 10). If offscreen fails to compile, proceed to Task 10 before committing — commit both together in that case with the Task 10 commit message. If it passes, commit now.

- [ ] **Step 5: Commit (if green)**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "feat(extension): plumb session id and transcription settings into capture start"
```

---

### Task 10: Offscreen — transcription queue wiring

**Files:**
- Modify: `apps/extension/entrypoints/offscreen/main.ts`

**Interfaces:**
- Consumes: `TranscriptionQueue`, `getTranscriptionProvider` (shared), `putSegments` (Task 7), widened `ToOffscreen`/`ToSidePanel` (Task 6), `clearSegments` (Task 7).
- Produces: segments in IndexedDB; `SEGMENT_SAVED` totals to the SW; `SEGMENTS_ADDED` broadcasts to the side panel.

- [ ] **Step 1: Extend imports and module state**

At the top of `offscreen/main.ts`:

```ts
import { SilenceChunker, TranscriptionQueue, encodeWav, getTranscriptionProvider } from '@scribetab/shared';
import type { Ack, ToOffscreen, ToSidePanel } from '@/utils/messages';
import { clearChunks, putChunk } from '@/utils/chunkStore';
import { clearSegments, putSegments } from '@/utils/segmentStore';
```

Add module-level state next to the existing `let` declarations:

```ts
let queue: TranscriptionQueue | null = null;
let segmentCount = 0;
```

- [ ] **Step 2: Build the queue in `start()`**

Change the signature of `start` to accept the full message payload:

```ts
async function start(msg: Extract<ToOffscreen, { type: 'OFFSCREEN_START' }>): Promise<void> {
```

and reference `msg.streamId` where `streamId` was used. In the listener, `await start(msg);` replaces `await start(msg.streamId);`.

Inside `start`, in the "graph is live" reset block (after `await clearChunks();`), add:

```ts
    // Abandon any still-retrying jobs from the previous session BEFORE
    // clearing its segments, or a late retry would resurrect them.
    queue?.cancel();
    await clearSegments();
    segmentCount = 0;
    queue = msg.transcription
      ? new TranscriptionQueue({
          sessionId: msg.sessionId,
          language: msg.transcription.language,
          transcribe: (req) =>
            getTranscriptionProvider(msg.transcription!.providerId).transcribe(req, {
              apiKey: msg.transcription!.apiKey,
              baseUrl: msg.transcription!.baseUrl,
              model: msg.transcription!.model,
            }),
          onSegments: async (segments) => {
            await putSegments(segments);
            segmentCount += segments.length;
            notifyBackground({ target: 'background', type: 'SEGMENT_SAVED', count: segmentCount });
            void chrome.runtime
              .sendMessage({
                target: 'sidepanel',
                type: 'SEGMENTS_ADDED',
                sessionId: msg.sessionId,
                segments,
              } satisfies ToSidePanel)
              .catch(() => {
                // Side panel not open — segments are in IndexedDB; it catches up on open.
              });
          },
        })
      : null;
```

Widen `notifyBackground`'s parameter type to accept the new message:

```ts
function notifyBackground(
  msg:
    | { target: 'background'; type: 'CHUNK_SAVED'; count: number }
    | { target: 'background'; type: 'SEGMENT_SAVED'; count: number }
    | { target: 'background'; type: 'CAPTURE_ENDED'; reason: string; error?: string }
    | { target: 'background'; type: 'MIC_STATUS'; status: 'active' | 'denied' | 'off' },
): void {
```

- [ ] **Step 3: Enqueue chunks after their audio write lands**

In `enqueueChunk`, inside the `writeChain.then` after `putChunk` succeeds and `CHUNK_SAVED` is sent, add:

```ts
      queue?.enqueue({
        index,
        wav,
        startMs: Math.round((startOffsetSamples / sampleRate) * 1000),
        durationMs: Math.round((pcm.length / sampleRate) * 1000),
      });
```

`enqueueChunk` needs `pcm.length` — it already receives `pcm`; capture `const lengthSamples = pcm.length;` before the async closure if needed (`pcm` must NOT be retained by reference inside the closure body beyond its length — the WAV bytes are already in `wav`). Concretely:

```ts
function enqueueChunk(pcm: Float32Array, sampleRate: number): void {
  const index = chunkIndex++;
  const startOffsetSamples = samplesWritten;
  const lengthSamples = pcm.length;
  samplesWritten += pcm.length;
  const wav = encodeWav(pcm, sampleRate);
  writeChain = writeChain.then(async () => {
    if (writeError) return;
    await putChunk({ index, sampleRate, startOffsetSamples, wav, createdAt: Date.now() });
    notifyBackground({ target: 'background', type: 'CHUNK_SAVED', count: index + 1 });
    queue?.enqueue({
      index,
      wav,
      startMs: Math.round((startOffsetSamples / sampleRate) * 1000),
      durationMs: Math.round((lengthSamples / sampleRate) * 1000),
    });
  }).catch((e) => {
    writeError = e instanceof Error ? e : new Error(String(e));
  });
}
```

- [ ] **Step 4: Leave finalize non-blocking on transcription**

`runFinalize` stays as-is (it already flushes the chunker into `enqueueChunk`, so the tail chunk gets transcribed). Do NOT `await queue.drain()` in finalize: stop must stay snappy; the offscreen document survives (USER_MEDIA reason, never closed by the SW) and in-flight jobs complete after stop, still landing in IndexedDB and the side panel.

- [ ] **Step 5: Typecheck, build, commit**

Run: `pnpm --filter @scribetab/extension typecheck && pnpm --filter @scribetab/extension build`
Expected: PASS (this closes the loop Task 9 may have left open).

```bash
git add apps/extension/entrypoints/offscreen/main.ts apps/extension/entrypoints/background.ts
git commit -m "feat(extension): offscreen transcription queue — chunks to segments, live broadcast"
```

---

### Task 11: Side panel — live transcript

**Files:**
- Create: `apps/extension/entrypoints/sidepanel/index.html`
- Create: `apps/extension/entrypoints/sidepanel/main.tsx`
- Modify: `apps/extension/entrypoints/popup/main.tsx`

WXT auto-registers a `sidepanel/` entrypoint in the manifest (`side_panel.default_path`); the `sidePanel` permission was added in Task 6.

**Interfaces:**
- Consumes: `getSegments` (Task 7), `ToSidePanel` (Task 6), storage keys `currentSessionId`, `captureState`, `transcriptionConfigured`, `micStatus` (Task 9).

- [ ] **Step 1: HTML shell**

```html
<!-- apps/extension/entrypoints/sidepanel/index.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ScribeTab transcript</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Live transcript UI**

```tsx
// apps/extension/entrypoints/sidepanel/main.tsx
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TranscriptSegment } from '@scribetab/shared';
import type { CaptureState, ToSidePanel } from '@/utils/messages';
import { getSegments } from '@/utils/segmentStore';

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function App() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [configured, setConfigured] = useState(true);
  const [micStatus, setMicStatus] = useState<string>('off');
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
    void chrome.storage.local
      .get(['currentSessionId', 'captureState', 'transcriptionConfigured', 'micStatus'])
      .then(async (v) => {
        setState((v.captureState as CaptureState) ?? 'idle');
        setConfigured((v.transcriptionConfigured as boolean) ?? true);
        setMicStatus((v.micStatus as string) ?? 'off');
        const sid = (v.currentSessionId as string) ?? null;
        setSessionId(sid);
        if (sid) setSegments(await getSegments(sid));
      });

    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.transcriptionConfigured) setConfigured(Boolean(c.transcriptionConfigured.newValue));
      if (c.micStatus) setMicStatus(String(c.micStatus.newValue ?? 'off'));
      if (c.currentSessionId) {
        const sid = (c.currentSessionId.newValue as string) ?? null;
        setSessionId(sid);
        setSegments([]);
        if (sid) void getSegments(sid).then(setSegments);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);

    const onMessage = (raw: unknown) => {
      const msg = raw as ToSidePanel;
      if (msg?.target !== 'sidepanel' || msg.type !== 'SEGMENTS_ADDED') return;
      if (sessionRef.current && msg.sessionId !== sessionRef.current) return;
      setSegments((prev) =>
        [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs),
      );
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [segments.length]);

  return (
    <main style={{ padding: 12, fontFamily: 'system-ui', fontSize: 14 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>Transcript</h1>
        <span style={{ fontSize: 12, color: state === 'recording' ? 'crimson' : '#555' }}>
          {state === 'recording' ? '● recording' : state}
          {micStatus === 'denied' && ' · mic denied — tab audio only'}
        </span>
      </header>

      {!configured && (
        <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 13 }}>
          No transcription provider configured (or its permission is missing) — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Open settings
          </a>
        </p>
      )}

      {segments.length === 0 ? (
        <p style={{ color: '#777' }}>Segments appear here as chunks are transcribed.</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
          {segments.map((s) => (
            <li key={s.id} style={{ margin: '6px 0' }}>
              <span style={{ color: '#999', fontSize: 11, marginRight: 6 }}>{fmt(s.startMs)}</span>
              <span style={s.text === '[transcription failed]' ? { color: 'crimson' } : undefined}>
                {s.text}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div ref={endRef} />
    </main>
  );
}

render(<App />, document.getElementById('app')!);
```

- [ ] **Step 3: "Open transcript" button in the popup**

In `apps/extension/entrypoints/popup/main.tsx`, add below the download button (inside `<main>`):

```tsx
      <button
        onClick={() => {
          void chrome.windows.getCurrent().then((w) => {
            if (w.id != null) void chrome.sidePanel.open({ windowId: w.id });
            window.close();
          });
        }}
      >
        Open transcript panel
      </button>
```

- [ ] **Step 4: Typecheck, build, commit**

Run: `pnpm --filter @scribetab/extension typecheck && pnpm --filter @scribetab/extension build`
Expected: PASS; built manifest contains `side_panel.default_path`.

```bash
git add apps/extension/entrypoints/sidepanel apps/extension/entrypoints/popup/main.tsx
git commit -m "feat(extension): live transcript side panel"
```

---

### Task 12: Optional mic mixing

Spec: mic merged echo-cancelled into the capture graph; denied → tab-only, surfaced in UI, never an error state. Mic audio must NOT reach the speakers (self-echo) — only the worklet.

**Files:**
- Modify: `apps/extension/entrypoints/offscreen/main.ts`

**Interfaces:**
- Consumes: `msg.micEnabled` (Task 6), `MIC_STATUS` message (Task 6), `micStatus` storage handling (Task 9), side-panel display (Task 11 — already renders `micStatus`).

- [ ] **Step 1: Track the mic stream in the engine**

Extend the `Engine` interface:

```ts
interface Engine {
  ctx: AudioContext;
  stream: MediaStream;
  micStream: MediaStream | null;
  node: AudioWorkletNode;
  chunker: SilenceChunker;
  sampleRate: number;
}
```

- [ ] **Step 2: Acquire and mix the mic in `start()`**

In `start`, declare `let micStream: MediaStream | null = null;` beside the other locals. Replace the two lines `const source = ... ; source.connect(ctx.destination);` and the later `source.connect(node);` wiring with:

```ts
    const tabSource = ctx.createMediaStreamSource(stream);
    tabSource.connect(ctx.destination); // tabCapture mutes the tab; keep it audible

    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    node = new AudioWorkletNode(ctx, 'pcm-capture');

    // Mix bus into the worklet: tab always; mic only if enabled AND granted.
    // Mic must never reach ctx.destination (the user would hear themselves).
    const mix = ctx.createGain();
    tabSource.connect(mix);
    if (msg.micEnabled) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true },
        });
        ctx.createMediaStreamSource(micStream).connect(mix);
        notifyBackground({ target: 'background', type: 'MIC_STATUS', status: 'active' });
      } catch {
        // Denied/unavailable → tab-only capture. Surfaced, never an error state.
        micStream = null;
        notifyBackground({ target: 'background', type: 'MIC_STATUS', status: 'denied' });
      }
    }
    mix.connect(node);
    // Keep the worklet in a live graph (Chrome has historically skipped
    // process() on nodes with no path to destination).
    node.connect(ctx.destination);
```

Note: `apps/extension/public/pcm-worklet.js` never writes to `outputs` (verified — its `process()` only posts frames over the port), so the worklet's output is silent and `node.connect(ctx.destination)` is a pure keep-alive: no mic audio can leak to the speakers through it. Do not add a zero-gain shim.

- [ ] **Step 3: Store and stop the mic**

Set `engine = { ctx, stream, micStream, node, chunker, sampleRate };` at the end of the try block, and in the catch add `micStream?.getTracks().forEach((t) => t.stop());` beside the existing cleanup.

In `runFinalize`, destructure `micStream` from the engine and add, next to `stream.getTracks()...`:

```ts
    micStream?.getTracks().forEach((t) => t.stop());
```

- [ ] **Step 4: Typecheck, build, commit**

Run: `pnpm --filter @scribetab/extension typecheck && pnpm --filter @scribetab/extension build`
Expected: PASS.

```bash
git add apps/extension/entrypoints/offscreen/main.ts
git commit -m "feat(extension): optional echo-cancelled mic mixing with graceful denial"
```

---

### Task 13: Full verification + milestone checklist + status docs

**Files:**
- Modify: `README.md` (status line only)

- [ ] **Step 1: Run the whole gate locally**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: all green — this is exactly what CI runs.

- [ ] **Step 2: Manual milestone verification (roadmap Phase 3 milestone)**

Load `apps/extension/.output/chrome-mv3` unpacked in Chrome and verify:

1. Options page: pick `groq` (or any provider you hold a key for), enter key, Save → Chrome shows the host-permission prompt → accept → "Access granted" status.
2. Open a YouTube video → popup → Start recording → popup "Open transcript panel".
3. Side panel fills with timestamped segments while the video plays (first segment ≈ 45–60 s in — chunk size — then steadily).
4. Stop recording → the tail chunk's segments still arrive after stop.
5. Localhost path: run any OpenAI-compatible whisper server (e.g. Speaches or LM Studio) → provider `custom`, base URL `http://localhost:<port>/v1`, no key → grant `http://localhost/*` → segments arrive with zero cloud traffic.
6. Kill the network mid-recording (or use a wrong key) → after ~21 s of backoff a crimson `[transcription failed]` gap segment appears; recording itself is unaffected and downloadable.
7. Provider unset → banner "No transcription provider configured…" in the side panel; recording + download still work.
8. Mic checkbox on → start → speak: your voice appears in the transcript; deny mic permission → "mic denied — tab audio only" in the panel header, capture continues.

If any step fails: STOP, use superpowers:systematic-debugging, fix, re-run this checklist from the failed step.

- [ ] **Step 3: Update README status**

In `README.md`, change the status paragraph to:

```markdown
**Status: early development.** Phases 1–3 (scaffold, capture engine, live
transcription with BYOK providers + local models) are implemented. See
`docs/superpowers/specs/` and `docs/superpowers/plans/` for the design and roadmap.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: Phase 3 (transcription) milestone reached"
```

---

## Self-review notes

- **Spec coverage:** adapters (5 ids incl. local-model custom) → Tasks 1–3; optional host permissions + options-page grant → Tasks 4, 6, 8, 9; queue with 1 s/4 s/16 s backoff + `[transcription failed]` gap → Task 5; options page with masked key in `chrome.storage.local` → Tasks 6, 8; side panel live transcript → Task 11; mic mixing with graceful denial → Task 12; milestone incl. localhost whisper → Task 13. Cost meter and PII redaction are Phase 7 by the roadmap — `costUsd` stays unset; not gaps.
- **Type consistency:** `TranscriptionJob`/`TranscriptionQueueOptions` (Task 5) match Task 10's call sites; `TranscriptionSettingsPayload` (Task 6) matches Tasks 9–10; `ToSidePanel` matches Tasks 10–11; `originPattern`/`transcriptionEndpoint` signatures identical in Tasks 3, 4, 8, 9.
- **Known judgment calls (fixtures define the contract; real-API drift is a one-line fix inside one adapter):** Mistral `timestamp_granularities` field name; `custom` omitting `response_format` for maximum local-server compatibility (falls back to whole-chunk segments); Deepgram `utterances=true` for segment timing.
