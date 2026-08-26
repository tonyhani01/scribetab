# ScribeTab Phase 1–2: Scaffold & Capture Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-08-26):** Tasks 5–6 rewritten after the 3-way MoA audit
(`MoA audit - 2026-08-26-phase-1-2-scaffold-and-capture.md`). Changes: targeted
message envelopes with a single responder (M1), one typed inbound union per
endpoint (M2), sample rate persisted per chunk (M3), offscreen created before
stream-id (M4), serialized IDB writes with sync index assignment (M5), one
idempotent finalize path for stop/track-ended/tab-closed (M6),
`runtime.getContexts` instead of Chrome-150-only `hasDocument` (M7), offscreen
never touches `chrome.storage` (M8), capture state machine refusing double
start and only wiping data after capture is granted (M10), assemble moved into
the popup via direct same-origin IndexedDB reads (removes a messaging leg),
PCM-concat assembly without float round-trip (S8/S9), empty recording rejected
(S10), `chrome.runtime.getURL` for the worklet (S11), start rollback +
finalize `finally` teardown (S1).

**Goal:** A pnpm monorepo where the ScribeTab extension records audio from a browser tab with one click on the extension (no picker, no bot), keeps the tab audible, chunks audio on silence boundaries, and saves a playable WAV — all local.

**Architecture:** MV3 extension (WXT + Preact). Popup → service worker (sole orchestrator, owns all `chrome.storage` state) → offscreen document (sole audio owner: capture, re-route to speakers, AudioWorklet → silence chunker → serialized WAV chunk writes to IndexedDB). The popup reads IndexedDB directly (same extension origin) to assemble and download the full recording — no offscreen round-trip.

**Tech Stack:** pnpm workspaces, TypeScript 5 (strict), WXT, Preact, Vitest, Chrome MV3 APIs (`tabCapture`, `offscreen`, `storage`, `downloads`, `runtime.getContexts`).

**Spec:** `docs/superpowers/specs/2026-08-26-scribetab-design.md`
**Roadmap (locked interfaces):** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md`

## Global Constraints

- License GPLv3; every `package.json` gets `"license": "GPL-3.0-only"`.
- No telemetry, no analytics, no network calls anywhere in Phases 1–2.
- Keys/settings only ever in `chrome.storage.local` (never `sync`) — no keys exist yet in these phases.
- `chrome.storage.*` is called ONLY from the service worker. Offscreen documents support only the `chrome.runtime` API.
- Node ≥ 20, pnpm ≥ 9, TypeScript `strict: true`.
- Chrome ≥ 116 (offscreen + `tabCapture.getMediaStreamId` + `runtime.getContexts`). Never use `chrome.offscreen.hasDocument()` — it is Chrome 150+.
- Package names: `@scribetab/shared`, `@scribetab/extension`.
- Commit style: conventional commits (`feat:`, `test:`, `chore:`, `ci:`).

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: workspace layout + `tsconfig.base.json` that Tasks 2–8 extend

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "scribetab",
  "private": true,
  "license": "GPL-3.0-only",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.output/
.wxt/
*.log
.DS_Store
```

`README.md`:
```markdown
# ScribeTab

Open-source, BYOK-first AI meeting transcriber. Captures audio straight from
browser tabs (Google Meet, Teams web, Zoom web, YouTube) — one click, no
screen-share picker, no bot in your call. Everything stays on your machine;
the only network traffic is the API call to the transcription/LLM endpoint
*you* configure (cloud key or localhost model). Transcripts are exposed to AI
agents and notetaking apps via MCP.

**Status: early development.** See `docs/superpowers/specs/` and
`docs/superpowers/plans/` for the design and roadmap.

License: GPL-3.0-only
```

- [ ] **Step 2: Verify install**

Run: `pnpm install`
Expected: completes, creates `pnpm-lock.yaml` (workspace has no members yet — that's fine).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo"
```

---

### Task 2: Shared package — locked types + WAV encoder (TDD)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/types.ts`, `packages/shared/src/wav.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/wav.test.ts`

**Interfaces:**
- Consumes: locked contracts from the roadmap doc — copy `types.ts` content **verbatim** from `2026-08-26-scribetab-roadmap.md` "Locked interface contracts"
- Produces:
  - `wavHeader(dataByteLength: number, sampleRate: number): ArrayBuffer` — 44-byte 16-bit mono PCM WAV header
  - `encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer` — full WAV file
  - all shared types re-exported from `@scribetab/shared`

- [ ] **Step 1: Package scaffolding**

`packages/shared/package.json`:
```json
{
  "name": "@scribetab/shared",
  "version": "0.0.1",
  "license": "GPL-3.0-only",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Types (verbatim from roadmap) and index**

`packages/shared/src/types.ts`: paste the entire code block from the roadmap's
"Locked interface contracts" section (both blocks: core types and the
native-host sync protocol), unchanged.

`packages/shared/src/index.ts`:
```ts
export * from './types';
export * from './wav';
```

- [ ] **Step 3: Write the failing WAV tests**

`packages/shared/test/wav.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeWav, wavHeader } from '../src/wav';

describe('wavHeader', () => {
  it('writes a valid 16-bit mono RIFF/WAVE header', () => {
    const buf = wavHeader(48000 * 2, 48000); // 1s of audio
    const view = new DataView(buf);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(buf.byteLength).toBe(44);
    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 48000 * 2);
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);        // mono
    expect(view.getUint32(24, true)).toBe(48000);    // sample rate
    expect(view.getUint16(34, true)).toBe(16);       // bits per sample
    expect(view.getUint32(40, true)).toBe(48000 * 2); // data byte length
  });
});

describe('encodeWav', () => {
  it('produces header + samples', () => {
    const samples = new Float32Array(48000);
    const buf = encodeWav(samples, 48000);
    expect(buf.byteLength).toBe(44 + 48000 * 2);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));
    expect(ascii(0, 4)).toBe('RIFF');
  });

  it('clamps and converts float samples to int16', () => {
    const samples = new Float32Array([0, 1, -1, 2, -2]); // 2/-2 must clamp
    const buf = encodeWav(samples, 16000);
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32768);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — `Cannot find module '../src/wav'` (or exports missing).

- [ ] **Step 5: Implement `wavHeader` and `encodeWav`**

`packages/shared/src/wav.ts`:
```ts
/** 44-byte header for a 16-bit mono PCM WAV file with the given data length. */
export function wavHeader(dataByteLength: number, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);
  return buf;
}

/** Encode mono float32 PCM as a complete 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const out = new Uint8Array(44 + dataLength);
  out.set(new Uint8Array(wavHeader(dataLength, sampleRate)), 0);
  const view = new DataView(out.buffer);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return out.buffer;
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter @scribetab/shared test`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @scribetab/shared typecheck
git add -A && git commit -m "feat(shared): locked domain types, WAV header and encoder"
```

---

### Task 3: Silence-aware chunker (TDD)

**Files:**
- Create: `packages/shared/src/chunker.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './chunker';`)
- Test: `packages/shared/test/chunker.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
```ts
interface ChunkerOptions {
  sampleRate: number;
  targetSeconds: number;   // start looking for a silence cut after this much audio
  maxSeconds: number;      // hard cut even mid-speech
  silenceThreshold: number; // RMS below this = silence (0..1)
  minSilenceMs: number;    // silence must persist this long to cut
}
class SilenceChunker {
  constructor(opts: ChunkerOptions);
  push(frame: Float32Array): Float32Array | null; // completed chunk or null
  flush(): Float32Array | null;                   // remaining audio, if any
}
```
Production defaults used by the extension: `targetSeconds: 45, maxSeconds: 60, silenceThreshold: 0.01, minSilenceMs: 300`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/chunker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SilenceChunker } from '../src/chunker';

const SR = 16000;
const opts = {
  sampleRate: SR,
  targetSeconds: 2,
  maxSeconds: 4,
  silenceThreshold: 0.01,
  minSilenceMs: 300,
};

function tone(seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  return out;
}
const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));

/** Feed audio in worklet-sized frames (128 samples); collect emitted chunks. */
function feed(chunker: SilenceChunker, audio: Float32Array): Float32Array[] {
  const chunks: Float32Array[] = [];
  for (let i = 0; i < audio.length; i += 128) {
    const c = chunker.push(audio.subarray(i, Math.min(i + 128, audio.length)));
    if (c) chunks.push(c);
  }
  return chunks;
}

describe('SilenceChunker', () => {
  it('does not cut before targetSeconds', () => {
    const chunker = new SilenceChunker(opts);
    expect(feed(chunker, tone(1.5))).toHaveLength(0);
  });

  it('cuts at the first sustained silence after targetSeconds', () => {
    const chunker = new SilenceChunker(opts);
    const audio = new Float32Array([...tone(2.5), ...silence(0.5), ...tone(1)]);
    const chunks = feed(chunker, audio);
    expect(chunks).toHaveLength(1);
    const durSec = chunks[0]!.length / SR;
    expect(durSec).toBeGreaterThanOrEqual(2.5); // includes the speech
    expect(durSec).toBeLessThan(3.2);           // cut inside the silence window
  });

  it('hard-cuts at maxSeconds when there is no silence', () => {
    const chunker = new SilenceChunker(opts);
    const chunks = feed(chunker, tone(5));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length / SR).toBeCloseTo(4, 1);
  });

  it('flush returns the remainder and then nothing', () => {
    const chunker = new SilenceChunker(opts);
    feed(chunker, tone(1));
    const rest = chunker.flush();
    expect(rest).not.toBeNull();
    expect(rest!.length / SR).toBeCloseTo(1, 1);
    expect(chunker.flush()).toBeNull();
  });

  it('works with production defaults at 48 kHz', () => {
    const sr = 48000;
    const chunker = new SilenceChunker({
      sampleRate: sr,
      targetSeconds: 45,
      maxSeconds: 60,
      silenceThreshold: 0.01,
      minSilenceMs: 300,
    });
    // 61s of tone at 48 kHz must hard-cut exactly once at ~60s.
    const out = new Float32Array(Math.round(61 * sr));
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const chunks: Float32Array[] = [];
    for (let i = 0; i < out.length; i += 128) {
      const c = chunker.push(out.subarray(i, Math.min(i + 128, out.length)));
      if (c) chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length / sr).toBeCloseTo(60, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — `Cannot find module '../src/chunker'`.

- [ ] **Step 3: Implement the chunker**

`packages/shared/src/chunker.ts`:
```ts
export interface ChunkerOptions {
  sampleRate: number;
  targetSeconds: number;
  maxSeconds: number;
  silenceThreshold: number;
  minSilenceMs: number;
}

/**
 * Accumulates PCM frames and emits chunks cut on sustained silence after
 * targetSeconds, with a hard cut at maxSeconds so a chunk can never grow
 * unbounded during continuous speech.
 */
export class SilenceChunker {
  private frames: Float32Array[] = [];
  private samples = 0;
  private silentSamples = 0;

  constructor(private opts: ChunkerOptions) {}

  push(frame: Float32Array): Float32Array | null {
    this.frames.push(frame.slice(0));
    this.samples += frame.length;

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += (frame[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    this.silentSamples = rms < this.opts.silenceThreshold
      ? this.silentSamples + frame.length
      : 0;

    const { sampleRate, targetSeconds, maxSeconds, minSilenceMs } = this.opts;
    const pastTarget = this.samples >= targetSeconds * sampleRate;
    const sustainedSilence = this.silentSamples >= (minSilenceMs / 1000) * sampleRate;
    const pastMax = this.samples >= maxSeconds * sampleRate;

    if ((pastTarget && sustainedSilence) || pastMax) return this.drain();
    return null;
  }

  flush(): Float32Array | null {
    return this.samples > 0 ? this.drain() : null;
  }

  private drain(): Float32Array {
    const out = new Float32Array(this.samples);
    let off = 0;
    for (const f of this.frames) {
      out.set(f, off);
      off += f.length;
    }
    this.frames = [];
    this.samples = 0;
    this.silentSamples = 0;
    return out;
  }
}
```

Add to `packages/shared/src/index.ts`:
```ts
export * from './chunker';
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @scribetab/shared test`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shared): silence-aware PCM chunker"
```

---

### Task 4: Extension scaffold (WXT + Preact)

**Files:**
- Create: `apps/extension/package.json`, `apps/extension/wxt.config.ts`, `apps/extension/tsconfig.json`, `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/popup/index.html`, `apps/extension/entrypoints/popup/main.tsx`

**Interfaces:**
- Consumes: workspace from Task 1
- Produces: buildable MV3 extension with the permission set every later task relies on: `tabCapture`, `offscreen`, `storage`, `downloads`, `activeTab`

- [ ] **Step 1: Package + config**

`apps/extension/package.json`:
```json
{
  "name": "@scribetab/extension",
  "version": "0.0.1",
  "license": "GPL-3.0-only",
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "typecheck": "wxt prepare && tsc --noEmit",
    "test": "echo 'no unit tests in extension yet'"
  },
  "dependencies": {
    "@scribetab/shared": "workspace:*",
    "preact": "^10.24.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "wxt": "^0.19.0"
  }
}
```

`apps/extension/wxt.config.ts`:
```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'ScribeTab',
    description:
      'BYOK meeting transcriber. Captures tab audio locally — no bot, no cloud storage.',
    permissions: ['tabCapture', 'offscreen', 'storage', 'downloads', 'activeTab'],
    minimum_chrome_version: '116',
  },
});
```

`apps/extension/tsconfig.json`:
```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true
  }
}
```

- [ ] **Step 2: Minimal entrypoints (placeholder logic, replaced in Tasks 5–6)**

`apps/extension/entrypoints/background.ts`:
```ts
export default defineBackground(() => {
  console.log('[scribetab] background ready');
});
```

`apps/extension/entrypoints/popup/index.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ScribeTab</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`apps/extension/entrypoints/popup/main.tsx`:
```tsx
import { render } from 'preact';

function App() {
  return <main style={{ minWidth: 260, padding: 12 }}>ScribeTab</main>;
}
render(<App />, document.getElementById('app')!);
```

- [ ] **Step 3: Install, build, verify**

Run: `pnpm install && pnpm --filter @scribetab/extension build`
Expected: build succeeds; `apps/extension/.output/chrome-mv3/manifest.json` exists and contains all five permissions and `"minimum_chrome_version": "116"`. Verify:
```bash
cat apps/extension/.output/chrome-mv3/manifest.json
```

- [ ] **Step 4: Manual smoke test**

Load `apps/extension/.output/chrome-mv3/` via `chrome://extensions` → "Load unpacked". Clicking the toolbar icon shows the "ScribeTab" popup. Service-worker console logs `[scribetab] background ready`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(extension): WXT + Preact MV3 scaffold with capture permissions"
```

---

### Task 5: Capture pipeline — messages, chunk store, background, offscreen

**Files:**
- Create: `apps/extension/utils/messages.ts`, `apps/extension/utils/chunkStore.ts`, `apps/extension/entrypoints/offscreen/index.html`, `apps/extension/entrypoints/offscreen/main.ts`, `apps/extension/public/pcm-worklet.js`
- Modify: `apps/extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: `SilenceChunker`, `encodeWav` from `@scribetab/shared`
- Produces (used verbatim by Task 6):
  - Message unions in `utils/messages.ts` (below). Every message carries a `target`; a listener returns `false` immediately for messages not addressed to it, so exactly one endpoint ever responds.
  - `utils/chunkStore.ts`: `putChunk(row: ChunkRow): Promise<void>`, `getAllChunks(): Promise<ChunkRow[]>` (sorted by index), `clearChunks(): Promise<void>`, with `interface ChunkRow { index: number; sampleRate: number; startOffsetSamples: number; wav: ArrayBuffer; createdAt: number }`
  - `chrome.storage.local` keys (written ONLY by the service worker): `captureState: 'idle' | 'starting' | 'recording' | 'stopping'`, `chunkCount: number`, `capturedTabId: number | null`

- [ ] **Step 1: Message protocol**

`apps/extension/utils/messages.ts`:
```ts
export type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping';

/** Messages handled by the service worker (from popup or offscreen). */
export type ToBackground =
  | { target: 'background'; type: 'START_CAPTURE' }
  | { target: 'background'; type: 'STOP_CAPTURE' }
  | { target: 'background'; type: 'CHUNK_SAVED'; count: number }      // offscreen → SW
  | { target: 'background'; type: 'CAPTURE_ENDED'; reason: string };  // offscreen → SW

/** Messages handled by the offscreen document (from the service worker only). */
export type ToOffscreen =
  | { target: 'offscreen'; type: 'OFFSCREEN_START'; streamId: string }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP' };

export interface Ack {
  ok: boolean;
  error?: string;
}
```

- [ ] **Step 2: Chunk store (same-origin IndexedDB, shared by offscreen writer and popup reader)**

`apps/extension/utils/chunkStore.ts`:
```ts
export interface ChunkRow {
  index: number;
  sampleRate: number;
  startOffsetSamples: number; // cumulative samples before this chunk (session-relative timing)
  wav: ArrayBuffer;
  createdAt: number;
}

const DB_NAME = 'scribetab';
const DB_VERSION = 1;
const STORE = 'audioChunks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'index' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putChunk(row: ChunkRow): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllChunks(): Promise<ChunkRow[]> {
  const db = await openDb();
  const rows = await new Promise<ChunkRow[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as ChunkRow[]);
    req.onerror = () => reject(req.error);
  });
  return rows.sort((a, b) => a.index - b.index);
}

export async function clearChunks(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```
Schema note: v1 is deliberately session-less; Phase 4 introduces `sessions` and
re-keys chunks as `[sessionId, index]` behind a DB version bump with a
migration test. `startOffsetSamples` exists now so chunk timing survives that
migration.

- [ ] **Step 3: Background — state machine + orchestration (sole `chrome.storage` writer)**

Replace `apps/extension/entrypoints/background.ts`:
```ts
import type { Ack, ToBackground, ToOffscreen } from '@/utils/messages';

async function ensureOffscreen(): Promise<void> {
  // hasDocument() is Chrome 150+; getContexts() works on our 116 floor.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // USER_MEDIA has no idle timeout and the live capture keeps the document
    // alive. Deliberately NOT declaring AUDIO_PLAYBACK: that reason closes the
    // document after 30s without audio, which would endanger silent meetings.
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture tab audio locally for transcription',
  });
}

function sendToOffscreen(msg: ToOffscreen): Promise<Ack> {
  return chrome.runtime.sendMessage(msg) as Promise<Ack>;
}

let opInFlight = false; // serializes start/stop within one SW lifetime

async function handleStart(): Promise<Ack> {
  if (opInFlight) return { ok: false, error: 'Operation in progress' };
  opInFlight = true;
  try {
    const { captureState } = await chrome.storage.local.get('captureState');
    if (captureState === 'recording' || captureState === 'starting') {
      return { ok: false, error: 'Already recording' };
    }
    await chrome.storage.local.set({ captureState: 'starting' });

    // Offscreen must exist BEFORE getMediaStreamId: stream ids are one-use
    // and expire within seconds, so the consumer must be ready.
    await ensureOffscreen();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    const res = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_START', streamId });
    if (!res?.ok) throw new Error(res?.error ?? 'Offscreen failed to start');

    await chrome.storage.local.set({
      captureState: 'recording',
      chunkCount: 0,
      capturedTabId: tab.id,
    });
    return { ok: true };
  } catch (e) {
    await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
    return { ok: false, error: String(e) };
  } finally {
    opInFlight = false;
  }
}

async function handleStop(): Promise<Ack> {
  if (opInFlight) return { ok: false, error: 'Operation in progress' };
  opInFlight = true;
  try {
    await chrome.storage.local.set({ captureState: 'stopping' });
    const res = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
    await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
    return res?.ok ? { ok: true } : { ok: false, error: res?.error ?? 'Stop failed' };
  } catch (e) {
    await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
    return { ok: false, error: String(e) };
  } finally {
    opInFlight = false;
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as ToBackground;
    if (msg?.target !== 'background') return false; // not ours — never hold the port

    (async () => {
      switch (msg.type) {
        case 'START_CAPTURE':
          sendResponse(await handleStart());
          break;
        case 'STOP_CAPTURE':
          sendResponse(await handleStop());
          break;
        case 'CHUNK_SAVED':
          // Offscreen cannot use chrome.storage — the SW owns all state.
          await chrome.storage.local.set({ chunkCount: msg.count });
          sendResponse({ ok: true });
          break;
        case 'CAPTURE_ENDED':
          await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
          sendResponse({ ok: true });
          break;
      }
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  // Belt-and-braces finalize: the captured tab going away must end the session
  // (the audio track's 'ended' event in the offscreen doc is the primary path).
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const { capturedTabId, captureState } = await chrome.storage.local.get([
        'capturedTabId',
        'captureState',
      ]);
      if (captureState === 'recording' && tabId === capturedTabId) {
        await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' }).catch(() => {});
        await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
      }
    })();
  });
});
```

- [ ] **Step 4: AudioWorklet processor**

`apps/extension/public/pcm-worklet.js`:
```js
// Downmixes to mono and posts 128-sample Float32 frames to the offscreen page.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const ch0 = input[0];
      if (input.length === 1) {
        this.port.postMessage(ch0.slice(0));
      } else {
        const mixed = new Float32Array(ch0.length);
        for (let c = 0; c < input.length; c++) {
          const ch = input[c];
          for (let i = 0; i < ch.length; i++) mixed[i] += ch[i] / input.length;
        }
        this.port.postMessage(mixed);
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
```

- [ ] **Step 5: Offscreen capture engine (no `chrome.storage`, serialized writes, idempotent finalize)**

`apps/extension/entrypoints/offscreen/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>ScribeTab offscreen</title></head>
  <body><script type="module" src="./main.ts"></script></body>
</html>
```

`apps/extension/entrypoints/offscreen/main.ts`:
```ts
import { SilenceChunker, encodeWav } from '@scribetab/shared';
import type { Ack, ToOffscreen } from '@/utils/messages';
import { clearChunks, putChunk } from '@/utils/chunkStore';

interface Engine {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  chunker: SilenceChunker;
  sampleRate: number;
}

let engine: Engine | null = null;
let finalized = true; // no session yet
let chunkIndex = 0;
let samplesWritten = 0;
let writeChain: Promise<void> = Promise.resolve();

function notifyBackground(msg: { target: 'background'; type: 'CHUNK_SAVED'; count: number } | { target: 'background'; type: 'CAPTURE_ENDED'; reason: string }): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // SW may be restarting; state converges via storage on its next event.
  });
}

/** Index and offset are assigned synchronously; writes are serialized on a chain. */
function enqueueChunk(pcm: Float32Array, sampleRate: number): void {
  const index = chunkIndex++;
  const startOffsetSamples = samplesWritten;
  samplesWritten += pcm.length;
  const wav = encodeWav(pcm, sampleRate);
  writeChain = writeChain
    .then(() => putChunk({ index, sampleRate, startOffsetSamples, wav, createdAt: Date.now() }))
    .then(() => notifyBackground({ target: 'background', type: 'CHUNK_SAVED', count: index + 1 }))
    .catch((e) => console.error('[scribetab] chunk write failed', e));
}

async function start(streamId: string): Promise<void> {
  if (engine) throw new Error('Capture already running');

  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
    } as MediaStreamConstraints);

    // Capture is granted — only NOW is it safe to discard the previous recording.
    await clearChunks();
    chunkIndex = 0;
    samplesWritten = 0;
    writeChain = Promise.resolve();

    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(ctx.destination); // tabCapture mutes the tab; keep it audible

    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    source.connect(node);

    const sampleRate = ctx.sampleRate;
    const chunker = new SilenceChunker({
      sampleRate,
      targetSeconds: 45,
      maxSeconds: 60,
      silenceThreshold: 0.01,
      minSilenceMs: 300,
    });

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (finalized) return;
      const done = chunker.push(e.data);
      if (done) enqueueChunk(done, sampleRate);
    };

    // Primary finalize trigger for tab close / capture loss.
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      void finalize('track-ended');
    });

    engine = { ctx, stream, node, chunker, sampleRate };
    finalized = false;
  } catch (e) {
    // Rollback: never leak tracks or contexts on a failed start.
    stream?.getTracks().forEach((t) => t.stop());
    await ctx?.close().catch(() => {});
    throw e;
  }
}

/** Idempotent. Shared by user stop, track-ended, and tab-removed paths. */
async function finalize(reason: string): Promise<void> {
  if (finalized || !engine) return;
  finalized = true;
  const { ctx, stream, node, chunker, sampleRate } = engine;
  engine = null;
  try {
    node.port.onmessage = null;
    node.disconnect();
    const rest = chunker.flush();
    if (rest && rest.length > 0) enqueueChunk(rest, sampleRate);
    await writeChain; // drain all pending IDB writes before acknowledging
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    notifyBackground({ target: 'background', type: 'CAPTURE_ENDED', reason });
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as ToOffscreen;
  if (msg?.target !== 'offscreen') return false; // not ours — never hold the port

  (async () => {
    switch (msg.type) {
      case 'OFFSCREEN_START':
        await start(msg.streamId);
        sendResponse({ ok: true } satisfies Ack);
        break;
      case 'OFFSCREEN_STOP':
        await finalize('user-stop');
        sendResponse({ ok: true } satisfies Ack);
        break;
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) } satisfies Ack));
  return true;
});
```

- [ ] **Step 6: Typecheck, build, manual verification**

Run: `pnpm typecheck && pnpm --filter @scribetab/extension build`, reload the
unpacked extension. On a YouTube tab, from the popup's devtools console:
```js
chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE' })
```
Expected: `{ok: true}`; tab audio **keeps playing audibly**; after ~45–60s
`chrome.storage.local.get('chunkCount')` shows ≥ 1. Send `START_CAPTURE` again
while recording → `{ok: false, error: 'Already recording'}` and the existing
chunks survive. Then `{ target: 'background', type: 'STOP_CAPTURE' }` →
`{ok: true}`, state `idle`. Close the tab mid-recording → state returns to
`idle` on its own.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extension): one-click tab capture with state machine, serialized chunk writes, idempotent finalize"
```

---

### Task 6: Popup UI — start/stop, chunk counter, download recording

**Files:**
- Modify: `apps/extension/entrypoints/popup/main.tsx`
- Create: `apps/extension/utils/assemble.ts`

**Interfaces:**
- Consumes: message protocol + storage keys from Task 5; `getAllChunks` from `utils/chunkStore.ts`; `wavHeader` from `@scribetab/shared`
- Produces: `assembleRecording(): Promise<{ blob: Blob; seconds: number }>` — throws `Error('Nothing recorded yet')` on zero chunks; popup UI states driven by `captureState`

- [ ] **Step 1: Assembly — PCM concatenation, no float round-trip**

`apps/extension/utils/assemble.ts`:
```ts
import { wavHeader } from '@scribetab/shared';
import { getAllChunks } from './chunkStore';

/**
 * Concatenates stored WAV chunks into one file by stripping each 44-byte
 * header and prepending a single new one. Raw int16 bytes are copied as-is —
 * no decode/re-encode, no lossy requantization, no large float buffers.
 */
export async function assembleRecording(): Promise<{ blob: Blob; seconds: number }> {
  const rows = await getAllChunks(); // sorted by index
  if (rows.length === 0) throw new Error('Nothing recorded yet');

  const sampleRate = rows[0]!.sampleRate;
  const dataLength = rows.reduce((n, r) => n + (r.wav.byteLength - 44), 0);
  const out = new Uint8Array(44 + dataLength);
  out.set(new Uint8Array(wavHeader(dataLength, sampleRate)), 0);

  let off = 44;
  for (const r of rows) {
    out.set(new Uint8Array(r.wav, 44), off);
    off += r.wav.byteLength - 44;
  }
  return {
    blob: new Blob([out], { type: 'audio/wav' }),
    seconds: dataLength / 2 / sampleRate,
  };
}
```
The popup shares the extension origin, so it reads IndexedDB directly — no
offscreen messaging, and the sample rate comes from the stored rows, never a
default.

- [ ] **Step 2: Popup UI**

Replace `apps/extension/entrypoints/popup/main.tsx`:
```tsx
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Ack, CaptureState } from '@/utils/messages';
import { assembleRecording } from '@/utils/assemble';

function App() {
  const [state, setState] = useState<CaptureState>('idle');
  const [chunks, setChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get(['captureState', 'chunkCount']).then((v) => {
      setState((v.captureState as CaptureState) ?? 'idle');
      setChunks((v.chunkCount as number) ?? 0);
    });
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.chunkCount) setChunks((c.chunkCount.newValue as number) ?? 0);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const send = async (type: 'START_CAPTURE' | 'STOP_CAPTURE') => {
    setError(null);
    const res = (await chrome.runtime.sendMessage({ target: 'background', type })) as Ack;
    if (!res?.ok) setError(res?.error ?? 'Unknown error');
  };

  const download = async () => {
    setError(null);
    try {
      const { blob, seconds } = await assembleRecording();
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `scribetab-recording-${Math.round(seconds)}s.wav`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = state === 'starting' || state === 'stopping';
  return (
    <main style={{ minWidth: 260, padding: 12, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 16, margin: '0 0 8px' }}>ScribeTab</h1>
      {state === 'recording' || state === 'stopping' ? (
        <button disabled={busy} onClick={() => send('STOP_CAPTURE')}>■ Stop recording</button>
      ) : (
        <button disabled={busy} onClick={() => send('START_CAPTURE')}>● Start recording this tab</button>
      )}
      <p data-testid="chunk-count" style={{ fontSize: 12, color: '#555' }}>
        Saved chunks: {chunks}
      </p>
      <button onClick={download} disabled={state !== 'idle'}>
        Download last recording (.wav)
      </button>
      {error && <p style={{ color: 'crimson', fontSize: 12 }}>{error}</p>}
    </main>
  );
}
render(<App />, document.getElementById('app')!);
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm typecheck && pnpm --filter @scribetab/extension build`
Expected: both green — the popup imports only `messages.ts`, `assemble.ts`, and shared; no cross-endpoint type unions exist to drift.

- [ ] **Step 4: End-to-end manual verification (the Phase 2 milestone)**

Build + reload. On a YouTube video:
1. Popup → "Start recording this tab" → audio stays audible, button flips to Stop.
2. Wait ~90s → "Saved chunks" reaches ≥ 1 live.
3. Stop → chunk count includes the flushed remainder.
4. "Download last recording" → open the WAV → it plays the tab audio **at correct speed/pitch** (sample rate comes from stored rows).
5. Download with nothing recorded → visible "Nothing recorded yet" error, no 44-byte file.
6. Start recording, close the tab → popup shows idle; downloading yields the audio captured up to the close.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(extension): popup start/stop, live chunk counter, direct-IDB WAV assembly and download"
```

---

### Task 7: CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts from Task 1
- Produces: green CI gate for every later phase

- [ ] **Step 1: Workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Verify locally (CI parity)**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "ci: typecheck, test, build on every push/PR"
```

Playwright e2e (extension loaded into a persistent Chromium context, capture
against a local page playing a tone) is intentionally deferred to Phase 3, when
the side panel gives the test something meaningful to assert; capture
correctness in Phase 2 is gated by the manual milestone in Task 6 Step 4.
Linting is added in Phase 3 alongside the first multi-contributor surface.

---

## Self-review (revision 2)

- **Spec coverage (Phases 1–2 scope):** monorepo ✓, GPLv3 metadata ✓, one-click
  no-picker capture ✓, audio re-route (stays audible) ✓, offscreen architecture ✓,
  silence chunker ✓ (TDD incl. production defaults at 48 kHz), local-only
  storage ✓, tab-close/track-ended finalize ✓, double-start protection ✓, CI ✓.
  Mic mixing and side panel are Phase 3 per roadmap.
- **Known limitations accepted for Phase 2:** single anonymous recording (no
  sessions until Phase 4); popup+button is the start gesture (hotkey lands in
  Phase 9 per roadmap; spec wording updated to match); `opInFlight` guard is
  per-SW-lifetime (storage state covers SW restarts).
- **Type consistency:** each endpoint has exactly one inbound union
  (`ToBackground`, `ToOffscreen`); popup consumes only `Ack`/`CaptureState`;
  `ChunkRow` is defined once in `chunkStore.ts` and used by writer and reader;
  `wavHeader`/`encodeWav`/`SilenceChunker` signatures match Tasks 2–3 and the
  assemble/offscreen call sites. Verified by `pnpm typecheck` in Tasks 5–6.
- **Placeholders:** none — every step has runnable content.
