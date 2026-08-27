import { originPattern, transcriptionEndpoint } from '@scribetab/shared';
import type { Ack, ToBackground, ToOffscreen, TranscriptionSettingsPayload } from '@/utils/messages';
import { platformFromUrl, titleFromTab } from '@/utils/platform';
import { checkQuota } from '@/utils/quota';
import { createSession, failStaleRecordings, finalizeSession } from '@/utils/sessionStore';
import { getSettings } from '@/utils/settings';

let creatingOffscreen: Promise<void> | null = null;

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

async function completeSession(
  sessionId: string | undefined,
  status: 'complete' | 'failed',
): Promise<void> {
  if (!sessionId) return;
  const s = await getSettings();
  await finalizeSession(sessionId, { retainAudio: s.retainAudio, status });
  await checkQuota().catch(() => {});
}

async function completeCurrentSession(status: 'complete' | 'failed'): Promise<void> {
  const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
  await completeSession(
    typeof currentSessionId === 'string' ? currentSessionId : undefined,
    status,
  );
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
    await failStaleRecordings(sessionId);
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
    } as const satisfies ToOffscreen;

    const first = await sendToOffscreen(startMsg);
    if (first?.ok) {
      offscreenStarted = true;
    } else if (/already running/i.test(first?.error ?? '')) {
      await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' }).catch(() => {});
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
      await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' }).catch(() => {});
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
    await chrome.storage.local.set({ captureState: 'stopping' });
    const res = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
    if (res?.ok) {
      await completeCurrentSession('complete');
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null, lastError: null });
      return { ok: true };
    }
    // A reply with ok:false means the offscreen listener ran finalize, which
    // always tears the engine down before responding — the recording is over,
    // its writes just failed. Going back to 'recording' would fight the
    // CAPTURE_ENDED handler's 'idle' and leave the partial audio undownloadable
    // (download requires 'idle'). Surface the error and settle at idle.
    await completeCurrentSession('failed');
    await chrome.storage.local.set({
      captureState: 'idle',
      capturedTabId: null,
      lastError: res?.error ?? 'Stop failed',
    });
    return { ok: false, error: res?.error ?? 'Stop failed' };
  } catch (e) {
    if ((await offscreenContexts()).length === 0) {
      await completeCurrentSession('failed');
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
  const { capturedTabId, captureState } = await chrome.storage.local.get([
    'capturedTabId',
    'captureState',
  ]);
  if (captureState !== 'recording' || tabId !== capturedTabId) return;
  const res = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' }).catch(
    () => null,
  );
  await completeCurrentSession(res && !res.ok ? 'failed' : 'complete');
  await chrome.storage.local.set({
    captureState: 'idle',
    capturedTabId: null,
    lastError: res && !res.ok ? (res.error ?? 'Stop failed') : null,
  });
}

export default defineBackground(() => {
  // Boot-time reconciliation: transient states can't survive their in-flight
  // handler, and 'recording' is only real if the offscreen document exists.
  void (async () => {
    const { captureState, currentSessionId } = await chrome.storage.local.get([
      'captureState',
      'currentSessionId',
    ]);
    const live =
      captureState === 'recording' && (await offscreenContexts()).length > 0;
    if (!live && (captureState === 'starting' || captureState === 'stopping' || captureState === 'recording')) {
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
    }
    await failStaleRecordings(live && typeof currentSessionId === 'string' ? currentSessionId : undefined);
  })();

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
        case 'SEGMENT_SAVED':
          await chrome.storage.local.set({ segmentCount: msg.count });
          sendResponse({ ok: true });
          break;
        case 'MIC_STATUS':
          await chrome.storage.local.set({ micStatus: msg.status });
          sendResponse({ ok: true });
          break;
        case 'CAPTURE_ENDED':
          await completeCurrentSession(msg.error ? 'failed' : 'complete');
          await chrome.storage.local.set({
            captureState: 'idle',
            capturedTabId: null,
            lastError: msg.error ?? null,
          });
          sendResponse({ ok: true });
          break;
      }
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void finalizeIfCaptured(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'loading' && info.url === undefined) return;
    void finalizeIfCaptured(tabId);
  });
});
