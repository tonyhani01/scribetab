import { SilenceChunker, TranscriptionQueue, encodeWav, getTranscriptionProvider, redactSegments } from '@scribetab/shared';
import type { Ack, ToOffscreen, ToSidePanel } from '@/utils/messages';
import { putChunk } from '@/utils/chunkStore';
import { offscreenStopApplies } from '@/utils/sessionIdentity';
import { putSegments } from '@/utils/segmentStore';

interface Engine {
  ctx: AudioContext;
  stream: MediaStream;
  micStream: MediaStream | null;
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
let queue: TranscriptionQueue | null = null;
let segmentCount = 0;
let captureSessionId = '';

function notifyBackground(
  msg:
    | { target: 'background'; type: 'CHUNK_SAVED'; count: number }
    | { target: 'background'; type: 'SEGMENT_SAVED'; count: number }
    | { target: 'background'; type: 'MIC_STATUS'; status: 'active' | 'denied' | 'off' }
    | { target: 'background'; type: 'CAPTURE_ENDED'; sessionId: string; reason: string; error?: string },
): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // SW may be restarting; state converges via storage on its next event.
  });
}

/** Index and offset are assigned synchronously; writes are serialized on a chain. */
function enqueueChunk(pcm: Float32Array, sampleRate: number): void {
  const index = chunkIndex++;
  const startOffsetSamples = samplesWritten;
  const lengthSamples = pcm.length;
  samplesWritten += pcm.length;
  const wav = encodeWav(pcm, sampleRate);
  writeChain = writeChain.then(async () => {
    if (writeError) return;
    await putChunk({
      sessionId: captureSessionId,
      index,
      sampleRate,
      startOffsetSamples,
      wav,
      createdAt: Date.now(),
    });
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

async function start(msg: Extract<ToOffscreen, { type: 'OFFSCREEN_START' }>): Promise<void> {
  const { streamId } = msg;
  // Wait for a finalize in flight, but swallow its rejection: a write failure
  // was already surfaced through the stop ACK / CAPTURE_ENDED, and it must not
  // poison the next session's start.
  if (finalizePromise) await finalizePromise.catch(() => {});
  if (engine) throw new Error('Capture already running');

  let stream: MediaStream | null = null;
  let micStream: MediaStream | null = null;
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
    // process() on nodes with no path to destination). pcm-worklet.js never
    // writes its outputs, so this connection is silent — no mic leak.
    node.connect(ctx.destination);

    const sampleRate = ctx.sampleRate;
    const chunker = new SilenceChunker({
      sampleRate,
      targetSeconds: 45,
      maxSeconds: 60,
      silenceThreshold: 0.01,
      minSilenceMs: 300,
    });

    // Graph is live. Do not wipe prior sessions — chunks/segments are
    // keyed by sessionId. Cancel the previous queue so its retries stop.
    queue?.cancel();
    captureSessionId = msg.sessionId;
    segmentCount = 0;
    const transcription = msg.transcription;
    queue = transcription
      ? new TranscriptionQueue({
          sessionId: msg.sessionId,
          language: transcription.language,
          transcribe: (req) =>
            getTranscriptionProvider(transcription.providerId).transcribe(req, {
              apiKey: transcription.apiKey,
              baseUrl: transcription.baseUrl,
              model: transcription.model,
            }),
          onSegments: async (segments) => {
            const stored = msg.redaction
              ? redactSegments(segments, { extraTerms: msg.redaction.extraTerms })
              : segments;
            await putSegments(stored);
            segmentCount += stored.length;
            notifyBackground({ target: 'background', type: 'SEGMENT_SAVED', count: segmentCount });
            void chrome.runtime
              .sendMessage({
                target: 'sidepanel',
                type: 'SEGMENTS_ADDED',
                sessionId: msg.sessionId,
                segments: stored,
              } satisfies ToSidePanel)
              .catch(() => {
                // Side panel not open — segments are in IndexedDB; it catches up on open.
              });
          },
        })
      : null;
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

    engine = { ctx, stream, micStream, node, chunker, sampleRate };
  } catch (e) {
    finalized = true;
    node?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    await ctx?.close().catch(() => {});
    throw e;
  }
}

async function runFinalize(reason: string): Promise<void> {
  if (!engine) return;
  finalized = true;
  const sessionId = captureSessionId;
  const { ctx, stream, micStream, node, chunker, sampleRate } = engine;
  engine = null;
  try {
    node.port.onmessage = null;
    node.disconnect();
    const rest = chunker.flush();
    if (rest && rest.length > 0) enqueueChunk(rest, sampleRate);
    await writeChain;
    if (queue) await queue.drain().catch(() => {});
    if (writeError) throw writeError;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    const error =
      writeError?.message ?? (reason === 'processor-error' ? 'processor-error' : undefined);
    notifyBackground({
      target: 'background',
      type: 'CAPTURE_ENDED',
      sessionId,
      reason,
      error,
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
        await start(msg);
        sendResponse({ ok: true } satisfies Ack);
        break;
      case 'OFFSCREEN_STOP':
        if (!offscreenStopApplies(msg.sessionId, captureSessionId)) {
          sendResponse({ ok: true } satisfies Ack);
          break;
        }
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
