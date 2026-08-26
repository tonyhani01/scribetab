import type { Ack, ToBackground, ToOffscreen } from '@/utils/messages';

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

let opInFlight = false; // serializes start/stop within one SW lifetime

async function handleStart(): Promise<Ack> {
  if (opInFlight) return { ok: false, error: 'Operation in progress' };
  opInFlight = true;
  let offscreenStarted = false;
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

    const first = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_START', streamId });
    if (first?.ok) {
      offscreenStarted = true;
    } else if (/already running/i.test(first?.error ?? '')) {
      await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' }).catch(() => {});
      const retry = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_START', streamId });
      if (!retry?.ok) throw new Error(retry?.error ?? first?.error ?? 'Offscreen failed to start');
      offscreenStarted = true;
    } else {
      throw new Error(first?.error ?? 'Offscreen failed to start');
    }

    await chrome.storage.local.set({
      captureState: 'recording',
      chunkCount: 0,
      capturedTabId: tab.id,
      lastError: null,
    });
    return { ok: true };
  } catch (e) {
    if (offscreenStarted) {
      await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' }).catch(() => {});
    }
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
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null, lastError: null });
      return { ok: true };
    }
    if ((await offscreenContexts()).length === 0) {
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
      return { ok: true };
    }
    await chrome.storage.local.set({
      captureState: 'recording',
      lastError: res?.error ?? 'Stop failed',
    });
    return { ok: false, error: res?.error ?? 'Stop failed' };
  } catch (e) {
    if ((await offscreenContexts()).length === 0) {
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
    const { captureState } = await chrome.storage.local.get('captureState');
    if (captureState === 'starting' || captureState === 'stopping') {
      await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
    } else if (captureState === 'recording') {
      if ((await offscreenContexts()).length === 0) {
        await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null });
      }
    }
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
        case 'CAPTURE_ENDED':
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
