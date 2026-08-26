# ScribeTab Phase 1–2: Scaffold & Capture Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pnpm monorepo where the ScribeTab extension records audio from a browser tab with one click (no picker, no bot), keeps the tab audible, chunks audio on silence boundaries, and saves a playable WAV — all local.

**Architecture:** MV3 extension (WXT + Preact). Popup click → service worker gets `tabCapture` stream ID → offscreen document captures, re-routes audio to speakers, and feeds an AudioWorklet → PCM frames run through a silence-aware chunker (pure, unit-tested, in `packages/shared`) → WAV chunks stored in IndexedDB → stop assembles one WAV for download.

**Tech Stack:** pnpm workspaces, TypeScript 5 (strict), WXT, Preact, Vitest, Chrome MV3 APIs (`tabCapture`, `offscreen`, `storage`, `downloads`).

**Spec:** `docs/superpowers/specs/2026-08-26-scribetab-design.md`
**Roadmap (locked interfaces):** `docs/superpowers/plans/2026-08-26-scribetab-roadmap.md`

## Global Constraints

- License GPLv3; every `package.json` gets `"license": "GPL-3.0-only"`.
- No telemetry, no analytics, no network calls anywhere in Phases 1–2.
- Keys/settings only ever in `chrome.storage.local` (never `sync`) — no keys exist yet in these phases.
- Node ≥ 20, pnpm ≥ 9, TypeScript `strict: true`.
- Chrome ≥ 116 (offscreen + tabCapture.getMediaStreamId).
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
- Produces: `encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer` (16-bit mono PCM WAV); all shared types re-exported from `@scribetab/shared`

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
"Locked interface contracts" section (both blocks: core types and
`SyncSessionMessage`), unchanged.

`packages/shared/src/index.ts`:
```ts
export * from './types';
export * from './wav';
```

- [ ] **Step 3: Write the failing WAV test**

`packages/shared/test/wav.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeWav } from '../src/wav';

describe('encodeWav', () => {
  it('produces a valid 16-bit mono RIFF/WAVE header', () => {
    const samples = new Float32Array(48000); // 1s of silence @48kHz
    const buf = encodeWav(samples, 48000);
    const view = new DataView(buf);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);        // mono
    expect(view.getUint32(24, true)).toBe(48000);    // sample rate
    expect(view.getUint16(34, true)).toBe(16);       // bits per sample
    expect(view.getUint32(40, true)).toBe(48000 * 2); // data byte length
    expect(buf.byteLength).toBe(44 + 48000 * 2);
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

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @scribetab/shared test`
Expected: FAIL — `Cannot find module '../src/wav'` (or export missing).

- [ ] **Step 5: Implement `encodeWav`**

`packages/shared/src/wav.ts`:
```ts
/** Encode mono float32 PCM as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter @scribetab/shared test`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @scribetab/shared typecheck
git add -A && git commit -m "feat(shared): locked domain types and WAV encoder"
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
Expected: PASS (6 tests total).

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

### Task 5: Capture pipeline — background, offscreen, worklet

**Files:**
- Create: `apps/extension/entrypoints/offscreen/index.html`, `apps/extension/entrypoints/offscreen/main.ts`, `apps/extension/public/pcm-worklet.js`, `apps/extension/utils/messages.ts`
- Modify: `apps/extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: `SilenceChunker`, `encodeWav` from `@scribetab/shared`
- Produces: runtime message protocol used by Task 6's popup:
  - `{ type: 'START_CAPTURE' }` popup → background
  - `{ type: 'STOP_CAPTURE' }` popup → background
  - `{ type: 'OFFSCREEN_START', streamId: string }` background → offscreen
  - `{ type: 'OFFSCREEN_STOP' }` background → offscreen
  - `chrome.storage.local` keys: `captureState: 'idle' | 'recording'`, `chunkCount: number`

- [ ] **Step 1: Message types**

`apps/extension/utils/messages.ts`:
```ts
export type PopupToBackground =
  | { type: 'START_CAPTURE' }
  | { type: 'STOP_CAPTURE' };

export type BackgroundToOffscreen =
  | { type: 'OFFSCREEN_START'; streamId: string }
  | { type: 'OFFSCREEN_STOP' };

export type CaptureState = 'idle' | 'recording';
```

- [ ] **Step 2: Background orchestration**

Replace `apps/extension/entrypoints/background.ts`:
```ts
import type { PopupToBackground } from '@/utils/messages';

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture tab audio locally for transcription',
    });
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: PopupToBackground, _sender, sendResponse) => {
    (async () => {
      if (msg.type === 'START_CAPTURE') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('No active tab');
        // One user gesture (popup click) → stream id, no screen picker, no bot.
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', streamId });
        await chrome.storage.local.set({ captureState: 'recording', chunkCount: 0 });
        sendResponse({ ok: true });
      } else if (msg.type === 'STOP_CAPTURE') {
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
        await chrome.storage.local.set({ captureState: 'idle' });
        sendResponse({ ok: true });
      }
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  });
});
```

- [ ] **Step 3: AudioWorklet processor**

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

- [ ] **Step 4: Offscreen capture engine**

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
import type { BackgroundToOffscreen } from '@/utils/messages';

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let chunker: SilenceChunker | null = null;
let chunkIndex = 0;

const DB_NAME = 'scribetab';
const STORE = 'audioChunks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'index' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveChunk(wav: ArrayBuffer): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ index: chunkIndex++, wav, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ chunkCount: chunkIndex });
}

async function clearChunks(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function start(streamId: string): Promise<void> {
  await clearChunks();
  chunkIndex = 0;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  } as MediaStreamConstraints);

  ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // tabCapture mutes the tab; keep it audible

  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  source.connect(node);

  chunker = new SilenceChunker({
    sampleRate: ctx.sampleRate,
    targetSeconds: 45,
    maxSeconds: 60,
    silenceThreshold: 0.01,
    minSilenceMs: 300,
  });

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const done = chunker?.push(e.data);
    if (done && ctx) void saveChunk(encodeWav(done, ctx.sampleRate));
  };
}

async function stop(): Promise<void> {
  const rest = chunker?.flush();
  if (rest && ctx) await saveChunk(encodeWav(rest, ctx.sampleRate));
  stream?.getTracks().forEach((t) => t.stop());
  await ctx?.close();
  ctx = null; stream = null; chunker = null;
}

chrome.runtime.onMessage.addListener((msg: BackgroundToOffscreen, _s, sendResponse) => {
  (async () => {
    if (msg.type === 'OFFSCREEN_START') await start(msg.streamId);
    if (msg.type === 'OFFSCREEN_STOP') await stop();
    sendResponse({ ok: true });
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
```

- [ ] **Step 5: Build and verify manually**

Run: `pnpm --filter @scribetab/extension build`, reload the unpacked extension.
On a YouTube tab: open the popup (Task 6 wires real buttons — for now trigger from
the popup console):
```js
chrome.runtime.sendMessage({ type: 'START_CAPTURE' })
```
Expected: tab audio **keeps playing audibly**; after ~45–60s `chrome.storage.local.get('chunkCount')` shows ≥ 1. Then `{ type: 'STOP_CAPTURE' }` → state `idle`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): one-click tab capture via offscreen AudioWorklet pipeline"
```

---

### Task 6: Popup UI — start/stop, chunk counter, download recording

**Files:**
- Modify: `apps/extension/entrypoints/popup/main.tsx`
- Modify: `apps/extension/entrypoints/offscreen/main.ts` (add `ASSEMBLE_WAV` handling)
- Modify: `apps/extension/utils/messages.ts`

**Interfaces:**
- Consumes: message protocol + storage keys from Task 5
- Produces: `{ type: 'ASSEMBLE_WAV' }` popup → offscreen, responds `{ ok: true, url: string, seconds: number }` (blob URL of full recording); popup UI states `idle`/`recording`

- [ ] **Step 1: Extend message types**

In `apps/extension/utils/messages.ts` add:
```ts
export type PopupToOffscreen = { type: 'ASSEMBLE_WAV' };
export interface AssembleResponse { ok: boolean; url?: string; seconds?: number; error?: string }
```

- [ ] **Step 2: Assemble endpoint in offscreen**

Append to `apps/extension/entrypoints/offscreen/main.ts` — extend the existing
`onMessage` listener with a third branch (keep start/stop branches unchanged):
```ts
// inside the async IIFE of the listener:
if (msg.type === 'ASSEMBLE_WAV') {
  const db = await openDb();
  const rows = await new Promise<{ index: number; wav: ArrayBuffer }[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  rows.sort((a, b) => a.index - b.index);
  // Concatenate PCM (skip each 44-byte WAV header), re-encode once.
  const sampleRate = ctx?.sampleRate ?? 48000;
  const totalInt16 = rows.reduce((n, r) => n + (r.wav.byteLength - 44) / 2, 0);
  const all = new Float32Array(totalInt16);
  let off = 0;
  for (const r of rows) {
    const int16 = new Int16Array(r.wav, 44);
    for (let i = 0; i < int16.length; i++) all[off + i] = (int16[i] ?? 0) / 32768;
    off += int16.length;
  }
  const url = URL.createObjectURL(new Blob([encodeWav(all, sampleRate)], { type: 'audio/wav' }));
  sendResponse({ ok: true, url, seconds: totalInt16 / sampleRate });
  return;
}
```
Note: `sendResponse` for this branch happens inside the branch; make sure the
listener still `return true`s for async response.

- [ ] **Step 3: Real popup UI**

Replace `apps/extension/entrypoints/popup/main.tsx`:
```tsx
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AssembleResponse, CaptureState } from '@/utils/messages';

function App() {
  const [state, setState] = useState<CaptureState>('idle');
  const [chunks, setChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local
      .get(['captureState', 'chunkCount'])
      .then((v) => {
        setState((v.captureState as CaptureState) ?? 'idle');
        setChunks((v.chunkCount as number) ?? 0);
      });
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.captureState) setState(c.captureState.newValue as CaptureState);
      if (c.chunkCount) setChunks((c.chunkCount.newValue as number) ?? 0);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const send = async (type: 'START_CAPTURE' | 'STOP_CAPTURE') => {
    setError(null);
    const res = await chrome.runtime.sendMessage({ type });
    if (!res?.ok) setError(res?.error ?? 'Unknown error');
  };

  const download = async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'ASSEMBLE_WAV' })) as AssembleResponse;
    if (!res.ok || !res.url) { setError(res.error ?? 'Nothing recorded yet'); return; }
    await chrome.downloads.download({
      url: res.url,
      filename: `scribetab-recording-${Date.now()}.wav`,
    });
  };

  return (
    <main style={{ minWidth: 260, padding: 12, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 16, margin: '0 0 8px' }}>ScribeTab</h1>
      {state === 'idle' ? (
        <button onClick={() => send('START_CAPTURE')}>● Start recording this tab</button>
      ) : (
        <button onClick={() => send('STOP_CAPTURE')}>■ Stop recording</button>
      )}
      <p data-testid="chunk-count" style={{ fontSize: 12, color: '#555' }}>
        Saved chunks: {chunks}
      </p>
      <button onClick={download} disabled={state === 'recording'}>
        Download last recording (.wav)
      </button>
      {error && <p style={{ color: 'crimson', fontSize: 12 }}>{error}</p>}
    </main>
  );
}
render(<App />, document.getElementById('app')!);
```
Note: `ASSEMBLE_WAV` is broadcast via `chrome.runtime.sendMessage`; the background
listener ignores unknown types, the offscreen listener answers. Verify the
background's listener does not `sendResponse` for `ASSEMBLE_WAV` (it only handles
`START_CAPTURE`/`STOP_CAPTURE` — confirm the switch falls through silently).

- [ ] **Step 4: End-to-end manual verification (the Phase 2 milestone)**

Build + reload. On a YouTube video:
1. Popup → "Start recording this tab" → audio stays audible.
2. Wait ~90s → "Saved chunks" reaches ≥ 1 live.
3. Stop → chunk count includes the flushed remainder.
4. "Download last recording" → open the WAV → it plays the tab audio.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(extension): popup start/stop, live chunk counter, WAV download"
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
the side panel gives the test something meaningful to assert; capture correctness
in Phase 2 is gated by the manual milestone in Task 6 Step 4.

---

## Self-review (done at plan time)

- **Spec coverage (Phases 1–2 scope):** monorepo ✓, GPLv3 metadata ✓, one-click
  no-picker capture ✓, audio re-route (stays audible) ✓, offscreen architecture ✓,
  silence chunker ✓ (TDD), local-only storage ✓, CI ✓. Mic mixing is Phase 3+ per
  roadmap (capture path must exist first); side panel is Phase 3.
- **Placeholders:** none — every step has runnable content.
- **Type consistency:** message types defined once in `utils/messages.ts` and
  imported by background/offscreen/popup; chunker/WAV signatures match between
  tasks and roadmap.
