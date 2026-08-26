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
