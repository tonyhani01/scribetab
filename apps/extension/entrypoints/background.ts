import {
  originPattern,
  redactSegment,
  redactSegments,
  transcriptionEndpoint,
} from '@scribetab/shared';
import type { TranscriptSegment } from '@scribetab/shared';
import {
  acceptsCaptionEvents,
  captionsOnlyFallbackNotice,
  freezeCaptionsOnly,
  fusionWaitMs,
  isCaptionSenderAllowed,
  LIVE_FUSION_MIN_MS,
} from '@/utils/captionGate';
import {
  captionCueToSegment,
  clearCaptionTimeline,
  fuseWithCaptions,
  ingestCaptionEvent,
  rehydrateCaptionTimeline,
  resetCaptionTimeline,
} from '@/utils/captionSession';
import {
  llmConfigured,
  retryPendingIntelligence,
  runFinalizeIntelligence,
  scheduleFinalizeIntelligence,
} from '@/utils/intelligence';
import type { Ack, ToBackground, ToMeetCaptions, ToOffscreen, ToSidePanel, TranscriptionSettingsPayload } from '@/utils/messages';
import { persistHostStatus, syncSessionToHost } from '@/utils/nativeSync';
import { platformFromUrl, titleFromTab } from '@/utils/platform';
import { checkQuota } from '@/utils/quota';
import { getSegments, putSegments } from '@/utils/segmentStore';
import {
  bootExceptId,
  bootShouldIdle,
  isLiveSession,
  statusFromCaptureEnded,
  statusFromOffscreenAck,
} from '@/utils/sessionIdentity';
import {
  createSession,
  failStaleRecordings,
  finalizeSession,
  getSession,
  listSessions,
  updateSession,
} from '@/utils/sessionStore';
import { getSettings } from '@/utils/settings';

let creatingOffscreen: Promise<void> | null = null;
let bootReady: Promise<void> = Promise.resolve();

type CaptionMsg = Extract<ToBackground, { type: 'CAPTION_EVENT' }>;
const captionBuffer: CaptionMsg[] = [];
let lastFusionMs = 0;
let fusionTimer: ReturnType<typeof setTimeout> | null = null;
let fusionQueuedSession: string | null = null;
let segmentCountChain: Promise<void> = Promise.resolve();

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

function notifySidePanel(msg: ToSidePanel): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Side panel not open — IndexedDB is the source of truth.
  });
}

function notifyMeetTab(tabId: number, active: boolean): void {
  const msg: ToMeetCaptions = { target: 'meet-captions', type: 'CAPTURE_ACTIVE', active };
  void chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Tab has no Meet content script (not meet.google.com, or not loaded yet).
  });
}

function syncSegmentCount(sessionId: string): Promise<void> {
  const done = segmentCountChain.then(async () => {
    const segs = await getSegments(sessionId);
    await chrome.storage.local.set({ segmentCount: segs.length });
  });
  segmentCountChain = done.catch(() => {});
  return done;
}

function clearFusionTimer(): void {
  if (fusionTimer != null) {
    clearTimeout(fusionTimer);
    fusionTimer = null;
  }
  fusionQueuedSession = null;
}

async function applyFusion(sessionId: string, force = false): Promise<void> {
  const { sessionCaptionsOnly } = await chrome.storage.local.get('sessionCaptionsOnly');
  if (sessionCaptionsOnly) return;

  if (!force) {
    const wait = fusionWaitMs(Date.now(), lastFusionMs, LIVE_FUSION_MIN_MS);
    if (wait > 0) {
      fusionQueuedSession = sessionId;
      if (fusionTimer == null) {
        fusionTimer = setTimeout(() => {
          fusionTimer = null;
          const id = fusionQueuedSession;
          fusionQueuedSession = null;
          if (id) void applyFusion(id, true);
        }, wait);
      }
      return;
    }
  }

  lastFusionMs = Date.now();
  const segs = await getSegments(sessionId);
  if (segs.length === 0) return;
  const fused = fuseWithCaptions(segs, sessionId);
  const changed = fused.filter((s, i) => s.speaker !== segs[i]?.speaker);
  if (changed.length === 0) return;
  const settings = await getSettings();
  const stored = settings.redactAtRest
    ? redactSegments(fused, { extraTerms: settings.redactTerms })
    : fused;
  await putSegments(stored);
  notifySidePanel({
    target: 'sidepanel',
    type: 'SEGMENTS_UPDATED',
    sessionId,
    segments: stored,
  });
}

async function applyCaptionEvent(
  sessionId: string,
  msg: CaptionMsg,
  originMs: number,
  captionsOnly: boolean,
): Promise<void> {
  const cue = await ingestCaptionEvent(sessionId, msg, originMs);
  if (!cue) return;

  if (captionsOnly) {
    let segment: TranscriptSegment = captionCueToSegment(sessionId, cue, crypto.randomUUID());
    const settings = await getSettings();
    if (settings.redactAtRest) {
      segment = redactSegment(segment, { extraTerms: settings.redactTerms });
    }
    await putSegments([segment]);
    await syncSegmentCount(sessionId);
    notifySidePanel({
      target: 'sidepanel',
      type: 'SEGMENTS_ADDED',
      sessionId,
      segments: [segment],
    });
  } else {
    await applyFusion(sessionId);
  }
}

async function handleCaptionEvent(
  msg: CaptionMsg,
  sender: chrome.runtime.MessageSender,
): Promise<Ack> {
  const { currentSessionId, captureState, capturedTabId, sessionCaptionsOnly } =
    await chrome.storage.local.get([
      'currentSessionId',
      'captureState',
      'capturedTabId',
      'sessionCaptionsOnly',
    ]);
  if (!isCaptionSenderAllowed(sender.tab?.id, capturedTabId)) {
    return { ok: true };
  }
  if (!acceptsCaptionEvents(captureState)) {
    return { ok: true };
  }
  if (typeof currentSessionId !== 'string') {
    captionBuffer.push(msg);
    return { ok: true };
  }
  const session = await getSession(currentSessionId);
  if (!session) return { ok: true };
  const { audioStartedAtMs } = await chrome.storage.local.get('audioStartedAtMs');
  const origin =
    session.audioStartedAtMs ??
    (typeof audioStartedAtMs === 'number' ? audioStartedAtMs : undefined);
  if (origin == null || !Number.isFinite(origin)) {
    captionBuffer.push(msg);
    return { ok: true };
  }
  const captionsOnly = Boolean(session.captionsOnly ?? sessionCaptionsOnly);
  await applyCaptionEvent(currentSessionId, msg, origin, captionsOnly);
  return { ok: true };
}

async function handleAudioStarted(
  msg: Extract<ToBackground, { type: 'AUDIO_STARTED' }>,
): Promise<Ack> {
  const { currentSessionId, sessionCaptionsOnly } = await chrome.storage.local.get([
    'currentSessionId',
    'sessionCaptionsOnly',
  ]);
  if (typeof currentSessionId === 'string' && currentSessionId !== msg.sessionId) {
    return { ok: true };
  }
  await updateSession(msg.sessionId, { audioStartedAtMs: msg.startedAtMs }).catch(() => {});
  await chrome.storage.local.set({ audioStartedAtMs: msg.startedAtMs });
  const buffered = captionBuffer.splice(0);
  const captionsOnly = Boolean(sessionCaptionsOnly);
  for (const ev of buffered) {
    await applyCaptionEvent(msg.sessionId, ev, msg.startedAtMs, captionsOnly);
  }
  return { ok: true };
}

async function handleCaptureQuery(sender: chrome.runtime.MessageSender): Promise<Ack> {
  const { capturedTabId, captureState } = await chrome.storage.local.get([
    'capturedTabId',
    'captureState',
  ]);
  const captured =
    isCaptionSenderAllowed(sender.tab?.id, capturedTabId) && acceptsCaptionEvents(captureState);
  return { ok: true, captured };
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
    baseUrl: s.providerId === 'custom' ? s.baseUrl || undefined : undefined,
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

async function setIdle(extra: Record<string, unknown> = {}): Promise<void> {
  const { capturedTabId } = await chrome.storage.local.get('capturedTabId');
  if (typeof capturedTabId === 'number') notifyMeetTab(capturedTabId, false);
  captionBuffer.length = 0;
  await chrome.storage.local.set({ captureState: 'idle', capturedTabId: null, ...extra });
}

async function completeSession(
  sessionId: string | undefined,
  status: 'complete' | 'failed',
): Promise<void> {
  if (!sessionId) return;
  clearFusionTimer();
  await applyFusion(sessionId, true).catch(() => {});
  await clearCaptionTimeline(sessionId).catch(() => {});
  const s = await getSettings();
  const flipped = await finalizeSession(sessionId, { retainAudio: s.retainAudio, status });
  if (flipped && status === 'complete') {
    // Do not await the LLM — STOP ack must return promptly. Pending is durable.
    await scheduleFinalizeIntelligence(sessionId, s);
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
  let startedTabId: number | null = null;
  try {
    const { captureState } = await chrome.storage.local.get('captureState');
    if (captureState === 'recording' || captureState === 'starting') {
      return { ok: false, error: 'Already recording' };
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error('No active tab');
    startedTabId = tab.id;

    await chrome.storage.local.set({
      captureState: 'starting',
      capturedTabId: tab.id,
      lastError: null,
      captureNotice: null,
    });
    notifyMeetTab(tab.id, true);

    // Offscreen must exist BEFORE getMediaStreamId: stream ids are one-use
    // and expire within seconds, so the consumer must be ready.
    await ensureOffscreen();

    const streamId = await getMediaStreamId({ targetTabId: tab.id });

    const settings = await getSettings();
    const platform = platformFromUrl(tab.url);
    const captionsOnly = freezeCaptionsOnly(settings.captionsOnly, platform);
    const transcription = captionsOnly ? null : await transcriptionPayload();
    const notice = captionsOnlyFallbackNotice(
      settings.captionsOnly,
      platform,
      transcription !== null,
    );
    const sessionId = crypto.randomUUID();
    createdId = sessionId;
    resetCaptionTimeline(sessionId);
    await failStaleRecordings(sessionId, settings.retainAudio);
    await createSession({
      id: sessionId,
      title: titleFromTab(tab),
      startedAt: new Date().toISOString(),
      platform,
      tabUrl: tab.url,
      status: 'recording',
      captionsOnly,
    });
    // Publish session id before offscreen start so AUDIO_STARTED / captions can land.
    await chrome.storage.local.set({
      currentSessionId: sessionId,
      sessionCaptionsOnly: captionsOnly,
      captureNotice: notice,
      transcriptionConfigured: captionsOnly || transcription !== null,
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
      transcriptionConfigured: captionsOnly || transcription !== null,
      micStatus: settings.micEnabled ? 'active' : 'off', // corrected by MIC_STATUS if denied
      capturedTabId: tab.id,
      sessionCaptionsOnly: captionsOnly,
      captureNotice: notice,
      lastError: null,
    });
    return { ok: true };
  } catch (e) {
    if (offscreenStarted) {
      await stopOffscreen(createdId ?? undefined).catch(() => {});
    }
    if (createdId) await completeSession(createdId, 'failed').catch(() => {});
    if (startedTabId != null) notifyMeetTab(startedTabId, false);
    captionBuffer.length = 0;
    await chrome.storage.local.set({
      captureState: 'idle',
      capturedTabId: null,
      sessionCaptionsOnly: false,
      captureNotice: null,
    });
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
      await setIdle({ lastError: null, sessionCaptionsOnly: false });
      return { ok: true };
    }
    // A reply with ok:false means the offscreen listener ran finalize, which
    // always tears the engine down before responding — the recording is over,
    // its writes just failed. Going back to 'recording' would fight the
    // CAPTURE_ENDED handler's 'idle' and leave the partial audio undownloadable
    // (download requires 'idle'). Surface the error and settle at idle.
    await completeSession(sessionId, 'failed');
    await setIdle({
      lastError: res?.error ?? 'Stop failed',
      sessionCaptionsOnly: false,
    });
    return { ok: false, error: res?.error ?? 'Stop failed' };
  } catch (e) {
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined;
    if ((await offscreenContexts()).length === 0) {
      await completeSession(sessionId, 'failed');
      await setIdle({ sessionCaptionsOnly: false });
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
  await setIdle({
    lastError: res && !res.ok ? (res.error ?? 'Stop failed') : res ? null : 'Offscreen unreachable',
    sessionCaptionsOnly: false,
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
      await setIdle();
    }
    const exceptId = bootExceptId(captureState, currentSessionId, offscreenAlive);
    const retainAudio = (await getSettings()).retainAudio;
    await failStaleRecordings(exceptId, retainAudio);
    void retryPendingIntelligence();
    if (
      typeof currentSessionId === 'string' &&
      acceptsCaptionEvents(captureState) &&
      !bootShouldIdle(captureState, offscreenAlive)
    ) {
      await rehydrateCaptionTimeline(currentSessionId).catch(() => {});
    }
  })();

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
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
        case 'SEGMENT_SAVED': {
          const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
          if (typeof currentSessionId === 'string') {
            await syncSegmentCount(currentSessionId);
            await applyFusion(currentSessionId).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }
        case 'AUDIO_STARTED':
          sendResponse(await handleAudioStarted(msg));
          break;
        case 'CAPTION_CAPTURE_QUERY':
          sendResponse(await handleCaptureQuery(sender));
          break;
        case 'CAPTION_EVENT':
          sendResponse(await handleCaptionEvent(msg, sender));
          break;
        case 'MIC_STATUS':
          await chrome.storage.local.set({ micStatus: msg.status });
          sendResponse({ ok: true });
          break;
        case 'CAPTURE_ENDED': {
          await completeSession(msg.sessionId, statusFromCaptureEnded(msg.error));
          const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
          if (isLiveSession(msg.sessionId, currentSessionId)) {
            await setIdle({
              lastError: msg.error ?? null,
              sessionCaptionsOnly: false,
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'REGENERATE_SUMMARY': {
          const settings = await getSettings();
          if (!llmConfigured(settings)) {
            sendResponse({ ok: false, error: 'No LLM configured' });
            break;
          }
          await updateSession(msg.sessionId, { intelligence: 'pending' });
          await runFinalizeIntelligence(msg.sessionId, settings);
          const row = await getSession(msg.sessionId);
          if (row?.intelligence === 'needs-permission') {
            sendResponse({ ok: false, error: 'needs-permission' });
            break;
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
