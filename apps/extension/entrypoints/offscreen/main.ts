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
let finalizePromise: Promise<void> | null = null;
let chunkIndex = 0;
let samplesWritten = 0;
let writeChain: Promise<void> = Promise.resolve();
let writeError: Error | null = null;

function notifyBackground(
  msg:
    | { target: 'background'; type: 'CHUNK_SAVED'; count: number }
    | { target: 'background'; type: 'CAPTURE_ENDED'; reason: string; error?: string },
): void {
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
  writeChain = writeChain.then(async () => {
    if (writeError) return;
    await putChunk({ index, sampleRate, startOffsetSamples, wav, createdAt: Date.now() });
    notifyBackground({ target: 'background', type: 'CHUNK_SAVED', count: index + 1 });
  }).catch((e) => {
    writeError = e instanceof Error ? e : new Error(String(e));
  });
}

async function start(streamId: string): Promise<void> {
  // Wait for a finalize in flight, but swallow its rejection: a write failure
  // was already surfaced through the stop ACK / CAPTURE_ENDED, and it must not
  // poison the next session's start.
  if (finalizePromise) await finalizePromise.catch(() => {});
  if (engine) throw new Error('Capture already running');

  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
    } as MediaStreamConstraints);

    ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (ctx.state !== 'running') {
      throw new Error(`AudioContext is ${ctx.state}, expected running`);
    }

    const source = ctx.createMediaStreamSource(stream);
    source.connect(ctx.destination); // tabCapture mutes the tab; keep it audible

    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    node = new AudioWorkletNode(ctx, 'pcm-capture');
    source.connect(node);
    // Keep the worklet in a live graph (Chrome has historically skipped
    // process() on nodes with no path to destination).
    node.connect(ctx.destination);

    const sampleRate = ctx.sampleRate;
    const chunker = new SilenceChunker({
      sampleRate,
      targetSeconds: 45,
      maxSeconds: 60,
      silenceThreshold: 0.01,
      minSilenceMs: 300,
    });

    // Graph is live — only now is it safe to discard the previous recording.
    await clearChunks();
    chunkIndex = 0;
    samplesWritten = 0;
    writeChain = Promise.resolve();
    writeError = null;
    finalizePromise = null;
    finalized = false;

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (finalized) return;
      const done = chunker.push(e.data);
      if (done) enqueueChunk(done, sampleRate);
    };
    node.onprocessorerror = () => {
      void finalize('processor-error');
    };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      void finalize('track-ended');
    });

    engine = { ctx, stream, node, chunker, sampleRate };
  } catch (e) {
    finalized = true;
    node?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    await ctx?.close().catch(() => {});
    throw e;
  }
}

async function runFinalize(reason: string): Promise<void> {
  if (!engine) return;
  finalized = true;
  const { ctx, stream, node, chunker, sampleRate } = engine;
  engine = null;
  try {
    node.port.onmessage = null;
    node.disconnect();
    const rest = chunker.flush();
    if (rest && rest.length > 0) enqueueChunk(rest, sampleRate);
    await writeChain;
    if (writeError) throw writeError;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    notifyBackground({
      target: 'background',
      type: 'CAPTURE_ENDED',
      reason,
      error: writeError ? writeError.message : undefined,
    });
  }
}

/** Idempotent. Shared by user stop, track-ended, navigation, and tab-removed. */
function finalize(reason: string): Promise<void> {
  if (finalizePromise) return finalizePromise;
  if (!engine) return Promise.resolve();
  finalizePromise = runFinalize(reason);
  return finalizePromise;
}

chrome.runtime.onMessage.addListener((raw: unknown, _s, sendResponse) => {
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
        sendResponse(
          (writeError
            ? { ok: false, error: writeError.message }
            : { ok: true }) satisfies Ack,
        );
        break;
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) } satisfies Ack));
  return true;
});
