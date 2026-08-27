import { originPattern, transcriptionEndpoint } from '@scribetab/shared';
import { getChunksForSession } from '@/utils/chunkStore';
import { audioDurationMs, runFinalizeIntelligence } from '@/utils/intelligence';
import type { Ack, ToBackground, ToOffscreen, TranscriptionSettingsPayload } from '@/utils/messages';
import { persistHostStatus, syncSessionToHost } from '@/utils/nativeSync';
import { platformFromUrl, titleFromTab } from '@/utils/platform';
import { checkQuota } from '@/utils/quota';
import {
  bootExceptId,
  bootShouldIdle,
  isLiveSession,
  statusFromCaptureEnded,
  statusFromOffscreenAck,
} from '@/utils/sessionIdentity';
import { createSession, failStaleRecordings, finalizeSession, getSession, listSessions } from '@/utils/sessionStore';
import { getSettings } from '@/utils/settings';

let creatingOffscreen: Promise<void> | null = null;
let bootReady: Promise<void> = Promise.resolve();

async function offscreenContexts(): Promise<chrome.runtime.ExtensionContext[]> {
  return chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
}

async function ensureOffscreen(): Promise<void> {
  // hasDocument() is Chrome 150+; getContexts() works on our 116 floor.
  if ((await offscreenContexts()).length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        // USER_MEDIA has no idle timeout and the live capture keeps the document
        // alive. Deliberately NOT declaring AUDIO_PLAYBACK: that reason closes the
        // document after 30s without audio, which would endanger silent meetings.
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Capture tab audio locally for transcription',
      })
      .then(() => undefined)
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  try {
    await creatingOffscreen;
  } catch (e) {
    if ((await offscreenContexts()).length === 0) throw e;
  }
}

function sendToOffscreen(msg: ToOffscreen): Promise<Ack> {
  return chrome.runtime.sendMessage(msg) as Promise<Ack>;
}

function stopOffscreen(sessionId?: string): Promise<Ack> {
  return sendToOffscreen(
    sessionId
      ? { target: 'offscreen', type: 'OFFSCREEN_STOP', sessionId }
      : { target: 'offscreen', type: 'OFFSCREEN_STOP' },
  );
}

// @types/chrome@0.0.280 only declares the callback overload for
// getMediaStreamId even though the runtime API supports promise style when
// the callback is omitted; wrap it so call sites can stay promise-based.
function getMediaStreamId(options: chrome.tabCapture.GetMediaStreamOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(options, (streamId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(streamId);
    });
  });
}

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

let opInFlight = false; // serializes start/stop within one SW lifetime

async function maybeSyncSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const session = await getSession(sessionId);
  if (!session || session.status !== 'complete') return;
  const status = await syncSessionToHost(session);
  await persistHostStatus(status);
}

async function completeSession(
  sessionId: string | undefined,
  status: 'complete' | 'failed',
): Promise<void> {
  if (!sessionId) return;
  const s = await getSettings();
  // STT minutes must be measured before finalize may delete audioChunks.
  const sttDurationMs =
    status === 'complete' ? audioDurationMs(await getChunksForSession(sessionId)) : 0;
  const flipped = await finalizeSession(sessionId, { retainAudio: s.retainAudio, status });
  if (flipped && status === 'complete') {
    await runFinalizeIntelligence(sessionId, s, { sttDurationMs }).catch(() => {});
  }
  await checkQuota().catch(() => {});
  // Offscreen drain() finishes before CAPTURE_ENDED / STOP ack, so transcripts are complete.
  if (flipped && status === 'complete') {
    try {
      await maybeSyncSession(sessionId);
    } catch (e) {
      await persistHostStatus({
        state: 'error',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
    }
  }
}

async function handleStart(): Promise<Ack> {
  if (opInFlight) return { ok: false, error: 'Operation in progress' };
  opInFlight = true;
  let offscreenStarted = false;
  let createdId: string | null = null;
  try {
    const { captureState } = await chrome.storage.local.get('captureState');
    if (captureState === 'recording' || captureState === 'starting') {
      return { ok: false, error: 'Already recording' };
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error('No active tab');

    await chrome.storage.local.set({ captureState: 'starting', lastError: null });

    // Offscreen must exist BEFORE getMediaStreamId: stream ids are one-use
    // and expire within seconds, so the consumer must be ready.
    await ensureOffscreen();

    const streamId = await getMediaStreamId({ targetTabId: tab.id });

    const settings = await getSettings();
    const transcription = await transcriptionPayload();
    const sessionId = crypto.randomUUID();
    await failStaleRecordings(sessionId, settings.retainAudio);
    createdId = sessionId;
    await createSession({
      id: sessionId,
      title: titleFromTab(tab),
      startedAt: new Date().toISOString(),
      platform: platformFromUrl(tab.url),
      tabUrl: tab.url,
      status: 'recording',
    });
    const startMsg = {
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      streamId,
      sessionId,
      transcription,
      micEnabled: settings.micEnabled,
      redaction: settings.redactAtRest ? { extraTerms: settings.redactTerms } : null,
    } as const satisfies ToOffscreen;

    const first = await sendToOffscreen(startMsg);
    if (first?.ok) {
      offscreenStarted = true;
    } else if (/already running/i.test(first?.error ?? '')) {
      await stopOffscreen().catch(() => {});
      const retry = await sendToOffscreen(startMsg);
      if (!retry?.ok) throw new Error(retry?.error ?? first?.error ?? 'Offscreen failed to start');
      offscreenStarted = true;
    } else {
      throw new Error(first?.error ?? 'Offscreen failed to start');
    }

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
    return { ok: true };
  } catch (e) {
    if (offscreenStarted) {
      await stopOffscreen(createdId ?? undefined).catch(() => {});
    }
    if (createdId) await completeSession(createdId, 'failed').catch(() => {});
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
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined;
    await chrome.storage.local.set({ captureState: 'stopping' });
    const res = await stopOffscreen(sessionId);
    if (res?.ok) {
      await completeSession(sessionId, 'complete');
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null, lastError: null });
      return { ok: true };
    }
    // A reply with ok:false means the offscreen listener ran finalize, which
    // always tears the engine down before responding — the recording is over,
    // its writes just failed. Going back to 'recording' would fight the
    // CAPTURE_ENDED handler's 'idle' and leave the partial audio undownloadable
    // (download requires 'idle'). Surface the error and settle at idle.
    await completeSession(sessionId, 'failed');
    await chrome.storage.local.set({
      captureState: 'idle',
      capturedTabId: null,
      lastError: res?.error ?? 'Stop failed',
    });
    return { ok: false, error: res?.error ?? 'Stop failed' };
  } catch (e) {
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined;
    if ((await offscreenContexts()).length === 0) {
      await completeSession(sessionId, 'failed');
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
      return { ok: true };
    }
    await chrome.storage.local.set({ captureState: 'recording', lastError: String(e) });
    return { ok: false, error: String(e) };
  } finally {
    opInFlight = false;
  }
}

async function finalizeIfCaptured(tabId: number): Promise<void> {
  const { capturedTabId, captureState, currentSessionId } = await chrome.storage.local.get([
    'capturedTabId',
    'captureState',
    'currentSessionId',
  ]);
  if (captureState !== 'recording' || tabId !== capturedTabId) return;
  const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined;
  const res = await stopOffscreen(sessionId).catch(() => null);
  await completeSession(sessionId, statusFromOffscreenAck(res));
  await chrome.storage.local.set({
    captureState: 'idle',
    capturedTabId: null,
    lastError: res && !res.ok ? (res.error ?? 'Stop failed') : res ? null : 'Offscreen unreachable',
  });
}

export default defineBackground(() => {
  // Boot-time reconciliation must finish before capture handlers run, otherwise
  // failStaleRecordings can mark a just-created session failed.
  bootReady = (async () => {
    const { captureState, currentSessionId } = await chrome.storage.local.get([
      'captureState',
      'currentSessionId',
    ]);
    const offscreenAlive = (await offscreenContexts()).length > 0;
    if (bootShouldIdle(captureState, offscreenAlive)) {
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
    }
    const exceptId = bootExceptId(captureState, currentSessionId, offscreenAlive);
    const retainAudio = (await getSettings()).retainAudio;
    await failStaleRecordings(exceptId, retainAudio);
  })();

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as ToBackground;
    if (msg?.target !== 'background') return false; // not ours — never hold the port

    (async () => {
      await bootReady;
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
        case 'SEGMENT_SAVED':
          await chrome.storage.local.set({ segmentCount: msg.count });
          sendResponse({ ok: true });
          break;
        case 'MIC_STATUS':
          await chrome.storage.local.set({ micStatus: msg.status });
          sendResponse({ ok: true });
          break;
        case 'CAPTURE_ENDED': {
          await completeSession(msg.sessionId, statusFromCaptureEnded(msg.error));
          const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
          if (isLiveSession(msg.sessionId, currentSessionId)) {
            await chrome.storage.local.set({
              captureState: 'idle',
              capturedTabId: null,
              lastError: msg.error ?? null,
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'SYNC_ALL': {
          const { captureState } = await chrome.storage.local.get('captureState');
          if (captureState === 'recording' || captureState === 'starting' || captureState === 'stopping') {
            sendResponse({ ok: false, error: 'Busy recording' });
            break;
          }
          const completed = (await listSessions()).filter((s) => s.status === 'complete');
          if (completed.length === 0) {
            sendResponse({ ok: false, error: 'Nothing to sync' });
            break;
          }
          let last: Awaited<ReturnType<typeof syncSessionToHost>> = { state: 'idle' };
          for (const session of completed) {
            last = await syncSessionToHost(session);
            await persistHostStatus(last);
            if (last.state !== 'ok' && last.state !== 'idle') break;
          }
          sendResponse({
            ok: last.state === 'ok',
            error: last.message,
            hostMissing: last.state === 'missing',
          } satisfies Ack);
          break;
        }
      }
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void bootReady.then(() => finalizeIfCaptured(tabId));
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'loading' && info.url === undefined) return;
    void bootReady.then(() => finalizeIfCaptured(tabId));
  });
});
