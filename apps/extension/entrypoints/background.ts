import {
  distinctSpeakers,
  originPattern,
  parseVocab,
  transcriptionEndpoint,
} from '@scribetab/shared';
import type { TranscriptSegment } from '@scribetab/shared';
import { computeLabels } from '@/utils/autoLabel';
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
  answerTranscriptQuestion,
  llmConfigured,
  markIntelligencePending,
  retryPendingIntelligence,
  runFinalizeIntelligence,
  scheduleFinalizeIntelligence,
} from '@/utils/intelligence';
import { answerLibraryQuestion } from '@/utils/libraryAsk';
import {
  captureOriginAfterResume,
  refreshActionBadge,
  refreshActiveTabBadge,
  surfaceCommandError,
} from '@/utils/actionBadge';
import {
  COMMAND_ADD_HIGHLIGHT,
  COMMAND_OPEN_SIDE_PANEL,
  COMMAND_START_CAPTURE,
  COMMAND_STOP_CAPTURE,
  liveHighlightStartMs,
  normalizeHighlightLabel,
} from '@/utils/commands';
import type {
  Ack,
  CaptureState,
  ToBackground,
  ToMeetCaptions,
  ToMeetConsent,
  ToOffscreen,
  ToSidePanel,
  TranscriptionIssue,
  TranscriptionSettingsPayload,
} from '@/utils/messages';
import {
  captureStateAfterToggle,
  isCapturingState,
  isLiveCaptureState,
} from '@/utils/messages';
import { exportSelectedActionItems } from '@/utils/actionExport';
import { normalizeHighlightKind, putHighlight } from '@/utils/highlightStore';
import {
  getUpcomingEvents,
  matchUpcomingEvent,
  persistHostStatus,
  syncSessionToHost,
} from '@/utils/nativeSync';
import { isCapturableUrl, isMeetingPlatform, platformFromUrl, titleFromTab } from '@/utils/platform';
import { checkQuota } from '@/utils/quota';
import { getSegments, putSegments } from '@/utils/segmentStore';
import {
  normalizeVocabReplacements,
  prepareFusedSegmentsForStorage,
  prepareSegmentsForStorage,
} from '@/utils/segmentIngest';
import { applyStoredSpeakerNames, renameStoredSpeaker } from '@/utils/speakerRename';
import {
  bootExceptId,
  bootShouldIdle,
  isLiveSession,
  statusFromCaptureEnded,
  statusFromOffscreenAck,
} from '@/utils/sessionIdentity';
import {
  archiveSession,
  createSession,
  editSessionSegment,
  failStaleRecordings,
  finalizeSession,
  getSession,
  importTranscriptSession,
  listSessions,
  purgeExpiredArchivedSessions,
  restoreSession,
  updateSession,
} from '@/utils/sessionStore';
import { getSettings, type Settings } from '@/utils/settings';
import { notifyReady } from '@/utils/notify';
import { persistLastTranscriptionError } from '@/utils/transcriptionError';
import { GENERIC_USER_ERROR, humanError } from '@/utils/userError';
import { deleteChunksForSession, sessionHasChunks } from '@/utils/chunkStore';
import { retentionCutoffMs, sessionsPastRetention } from '@scribetab/shared';
import { PerSessionMutationQueue } from '@/utils/sessionMutationQueue';

let creatingOffscreen: Promise<void> | null = null;
let bootReady: Promise<void> = Promise.resolve();

type CaptionMsg = Extract<ToBackground, { type: 'CAPTION_EVENT' }>;
const captionBuffer: CaptionMsg[] = [];
let lastFusionMs = 0;
let fusionTimer: ReturnType<typeof setTimeout> | null = null;
let fusionQueuedSession: string | null = null;
let segmentCountChain: Promise<void> = Promise.resolve();
const sessionMutationQueue = new PerSessionMutationQueue();

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
  await sessionMutationQueue.run(sessionId, async () => {
    const segs = await getSegments(sessionId);
    if (segs.length === 0) return;
    const fused = fuseWithCaptions(segs, sessionId);
    const session = await getSession(sessionId);
    const named = applyStoredSpeakerNames(fused, session?.speakerNames);
    const settings = await getSettings();
    const stored = prepareFusedSegmentsForStorage(
      named,
      settings.redactAtRest ? { extraTerms: settings.redactTerms } : null,
    );
    const changed = stored.some(
      (segment, index) =>
        segment.speaker !== segs[index]?.speaker || segment.text !== segs[index]?.text,
    );
    if (!changed) return;
    await putSegments(stored);
    notifySidePanel({
      target: 'sidepanel',
      type: 'SEGMENTS_UPDATED',
      sessionId,
      segments: stored,
    });
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
    await sessionMutationQueue.run(sessionId, async () => {
      const segment: TranscriptSegment = captionCueToSegment(sessionId, cue, crypto.randomUUID());
      const session = await getSession(sessionId);
      const named = applyStoredSpeakerNames([segment], session?.speakerNames)[0]!;
      const [settings, captureState] = await Promise.all([
        getSettings(),
        chrome.storage.local.get('sessionVocabReplacements'),
      ]);
      const replacements = normalizeVocabReplacements(captureState.sessionVocabReplacements);
      const stored = prepareSegmentsForStorage(
        [named],
        settings.redactAtRest ? { extraTerms: settings.redactTerms } : null,
        replacements,
      )[0]!;
      await putSegments([stored]);
      await syncSegmentCount(sessionId);
      notifySidePanel({
        target: 'sidepanel',
        type: 'SEGMENTS_ADDED',
        sessionId,
        segments: [stored],
      });
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
    (typeof audioStartedAtMs === 'number' ? audioStartedAtMs : undefined) ??
    session.audioStartedAtMs;
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
  await chrome.storage.local.set({
    audioStartedAtMs: msg.startedAtMs,
    capturePausedAtMs: null,
  });
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
async function transcriptionStatus(s: Settings): Promise<{
  payload: TranscriptionSettingsPayload | null;
  issue: TranscriptionIssue;
}> {
  if (s.providerId === '') return { payload: null, issue: 'unconfigured' };
  let endpoint: string;
  try {
    endpoint = transcriptionEndpoint(s.providerId, s.baseUrl || undefined);
  } catch {
    return { payload: null, issue: 'unconfigured' }; // custom without baseUrl
  }
  if (s.providerId !== 'custom' && !s.apiKey) return { payload: null, issue: 'unconfigured' };
  const granted = await chrome.permissions.contains({ origins: [originPattern(endpoint)] });
  if (!granted) return { payload: null, issue: 'missing-permission' };
  return {
    payload: {
      providerId: s.providerId,
      apiKey: s.apiKey,
      model: s.model || undefined,
      language: s.language || undefined,
      baseUrl: s.providerId === 'custom' ? s.baseUrl || undefined : undefined,
      diarize: s.diarize,
      smartMode: s.providerId === 'google' ? s.googleSmartMode : undefined,
    },
    issue: null,
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
  if (typeof capturedTabId === 'number') {
    notifyMeetTab(capturedTabId, false);
    notifyMeetConsent(capturedTabId, false);
  }
  captionBuffer.length = 0;
  await chrome.storage.local.set({
    captureState: 'idle',
    capturedTabId: null,
    capturePausedAtMs: null,
    sessionVocabReplacements: [],
    ...extra,
  });
  // Clear REC on the tab we captured, not whatever is focused now.
  if (typeof capturedTabId === 'number') void refreshActionBadge(capturedTabId);
  void refreshActiveTabBadge();
  void sweepRetainedAudio().catch(() => {});
}

/** Show or hide the in-tab consent reminder on the captured Meet tab. */
function notifyMeetConsent(tabId: number | null | undefined, show: boolean): void {
  if (typeof tabId !== 'number') return;
  const msg: ToMeetConsent = { target: 'meet-consent', type: show ? 'SHOW_CONSENT' : 'HIDE_CONSENT' };
  try {
    void Promise.resolve(chrome.tabs.sendMessage(tabId, msg)).catch(() => {
      // Tab has no content script (not Meet) — fine.
    });
  } catch {
    // Best effort: stopping capture must not fail because the tab disappeared.
  }
}

/**
 * Retention sweep: delete audio chunks of completed sessions older than the
 * configured window. Runs on finalize and on SW boot. Never touches the live
 * recording, segments, or session rows.
 */
export async function sweepRetainedAudio(): Promise<number> {
  const settings = await getSettings();
  // finalizeSession only drops chunks for the session it finalizes, so turning
  // audio retention off must also clear the backlog kept while it was on.
  const cutoff = settings.retainAudio
    ? retentionCutoffMs(Date.now(), settings.retentionDays)
    : Date.now();
  if (cutoff == null) return 0;
  const sessions = await listSessions();
  const withAudio = new Set<string>();
  for (const s of sessions) {
    if (await sessionHasChunks(s.id)) withAudio.add(s.id);
  }
  const victims = sessionsPastRetention(sessions, withAudio, cutoff);
  for (const id of victims) {
    await deleteChunksForSession(id).catch(() => {});
  }
  return victims.length;
}

/**
 * Derive system labels (1:1, Long, Meet/Zoom/Teams/YouTube) from session facts
 * and persist them. Speaker count uses alias-resolved names so merged speakers
 * count once. Best-effort: labeling must never break the finalize path.
 */
async function applyAutoLabels(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  const segs = await getSegments(sessionId);
  const named = applyStoredSpeakerNames(segs, session.speakerNames);
  const endedMs = session.endedAt ? Date.parse(session.endedAt) : Number.NaN;
  const startedMs = Date.parse(session.startedAt);
  const durationMs =
    Number.isFinite(endedMs) && Number.isFinite(startedMs) && endedMs > startedMs
      ? endedMs - startedMs
      : 0;
  await updateSession(sessionId, {
    labels: computeLabels({
      title: session.title,
      durationMs,
      speakerCount: distinctSpeakers(named).length,
      url: session.tabUrl,
    }),
  });
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
  if (flipped) {
    await updateSession(sessionId, {
      providerId: s.providerId || undefined,
      model: s.model.trim() || undefined,
    });
    await applyAutoLabels(sessionId).catch(() => {});
  }
  if (flipped && status === 'complete') {
    const [session, segs] = await Promise.all([
      getSession(sessionId).catch(() => undefined),
      getSegments(sessionId).catch(() => []),
    ]);
    if (segs.length > 0) {
      notifyReady('transcript', session?.title ?? 'Untitled meeting', s.notifyOnReady);
    }
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

/** A calendar event overlapping this window around "now" may name the session. */
const CALENDAR_TITLE_SKEW_MS = 5 * 60 * 1000;

/**
 * Best-effort session naming from the user's calendar: if a meeting is happening right
 * now and the recorded tab is a known meeting URL, its title beats the page title.
 * Never rejects and never blocks capture — any miss (no host, empty feed, the user
 * renamed first) leaves the tab-derived title in place.
 */
async function applyCalendarTitle(
  sessionId: string,
  tabUrl: string | undefined,
  fallbackTitle: string,
): Promise<void> {
  try {
    if (!isMeetingPlatform(tabUrl)) return;
    const events = await getUpcomingEvents();
    const match = matchUpcomingEvent(events, Date.now(), CALENDAR_TITLE_SKEW_MS);
    if (!match) return;
    const current = await getSession(sessionId);
    if (!current || current.status !== 'recording') return;
    if (current.title !== fallbackTitle) return; // renamed in the meantime
    await updateSession(sessionId, { title: match.title });
  } catch {
    // Cosmetic only — recording continues with the tab title.
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
    if (isLiveCaptureState(captureState)) {
      return { ok: false, error: 'Already recording' };
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error('No active tab');
    if (!isCapturableUrl(tab.url)) throw new Error('This page cannot be recorded.');
    startedTabId = tab.id;

    await chrome.storage.local.set({
      captureState: 'starting',
      capturedTabId: tab.id,
      lastError: null,
      lastTranscriptionError: null,
      captureNotice: null,
      audioStartedAtMs: null,
      capturePausedAtMs: null,
      chunkCount: 0,
      transcribedCount: 0,
      segmentCount: 0,
    });
    const settings = await getSettings();
    const vocab = parseVocab(settings.vocabTerms);
    notifyMeetTab(tab.id, true);
    if (settings.consentReminder) notifyMeetConsent(tab.id, true);

    // Offscreen must exist BEFORE getMediaStreamId: stream ids are one-use
    // and expire within seconds, so the consumer must be ready.
    await ensureOffscreen();

    const streamId = await getMediaStreamId({ targetTabId: tab.id });

    const platform = platformFromUrl(tab.url);
    const captionsOnly = freezeCaptionsOnly(settings.captionsOnly, platform);
    const { payload, issue } = captionsOnly
      ? { payload: null, issue: null as TranscriptionIssue }
      : await transcriptionStatus(settings);
    const transcription = payload ? { ...payload, vocabHints: vocab.hints } : null;
    const notice = captionsOnlyFallbackNotice(
      settings.captionsOnly,
      platform,
      transcription !== null,
    );
    const sessionId = crypto.randomUUID();
    const tabTitle = titleFromTab(tab);
    createdId = sessionId;
    resetCaptionTimeline(sessionId);
    await failStaleRecordings(sessionId, settings.retainAudio);
    await createSession({
      id: sessionId,
      title: tabTitle,
      startedAt: new Date().toISOString(),
      platform,
      tabUrl: tab.url,
      status: 'recording',
      captionsOnly,
    });
    // Fire-and-forget: naming the session from the calendar must never delay START.
    void applyCalendarTitle(sessionId, tab.url, tabTitle);
    // Publish session id before offscreen start so AUDIO_STARTED / captions can land.
    await chrome.storage.local.set({
      currentSessionId: sessionId,
      sessionCaptionsOnly: captionsOnly,
      sessionVocabReplacements: vocab.replacements,
      captureNotice: notice,
      transcriptionConfigured: captionsOnly || transcription !== null,
      transcriptionIssue: captionsOnly ? null : issue,
    });
    const startMsg = {
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      streamId,
      sessionId,
      transcription,
      micEnabled: settings.micEnabled,
      redaction: settings.redactAtRest ? { extraTerms: settings.redactTerms } : null,
      replacements: vocab.replacements,
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
      transcribedCount: 0,
      segmentCount: 0,
      currentSessionId: sessionId,
      transcriptionConfigured: captionsOnly || transcription !== null,
      transcriptionIssue: captionsOnly ? null : issue,
      micStatus: settings.micEnabled ? 'active' : 'off', // corrected by MIC_STATUS if denied
      capturedTabId: tab.id,
      sessionCaptionsOnly: captionsOnly,
      captureNotice: notice,
      lastError: null,
    });
    void refreshActionBadge(tab.id, tab.url);
    return { ok: true };
  } catch (e) {
    if (offscreenStarted) {
      await stopOffscreen(createdId ?? undefined).catch(() => {});
    }
    if (createdId) await completeSession(createdId, 'failed').catch(() => {});
    if (startedTabId != null) {
      notifyMeetTab(startedTabId, false);
      notifyMeetConsent(startedTabId, false);
    }
    captionBuffer.length = 0;
    const startError = humanError(e);
    await chrome.storage.local.set({
      captureState: 'idle',
      capturedTabId: null,
      sessionCaptionsOnly: false,
      sessionVocabReplacements: [],
      captureNotice: null,
      lastError: startError,
    });
    if (startedTabId != null) void refreshActionBadge(startedTabId);
    void refreshActiveTabBadge();
    return { ok: false, error: startError };
  } finally {
    opInFlight = false;
  }
}

async function handleStop(): Promise<Ack> {
  if (opInFlight) return { ok: false, error: 'Operation in progress' };
  opInFlight = true;
  let previousCaptureState: CaptureState = 'recording';
  try {
    const { currentSessionId, captureState } = await chrome.storage.local.get([
      'currentSessionId',
      'captureState',
    ]);
    if (isCapturingState(captureState)) previousCaptureState = captureState;
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
      lastError: humanError(res?.error ?? 'Stop failed'),
      sessionCaptionsOnly: false,
    });
    return { ok: false, error: humanError(res?.error ?? 'Stop failed') };
  } catch (e) {
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined;
    if ((await offscreenContexts()).length === 0) {
      await completeSession(sessionId, 'failed');
      await setIdle({ sessionCaptionsOnly: false });
      return { ok: true };
    }
    await chrome.storage.local.set({ captureState: previousCaptureState, lastError: humanError(e) });
    return { ok: false, error: humanError(e) };
  } finally {
    opInFlight = false;
  }
}

async function handlePauseToggle(wantPaused: boolean): Promise<Ack> {
  if (opInFlight) return { ok: false, error: 'Operation in progress' };
  opInFlight = true;
  let offscreenToggled = false;
  try {
    const {
      captureState,
      capturedTabId,
      currentSessionId,
      audioStartedAtMs,
      capturePausedAtMs,
    } = await chrome.storage.local.get([
      'captureState',
      'capturedTabId',
      'currentSessionId',
      'audioStartedAtMs',
      'capturePausedAtMs',
    ]);
    const nextState = captureStateAfterToggle(captureState, wantPaused);
    if (!nextState) {
      return {
        ok: false,
        error: wantPaused ? 'Capture is not recording' : 'Capture is not paused',
      };
    }
    const res = await sendToOffscreen({
      target: 'offscreen',
      type: wantPaused ? 'OFFSCREEN_PAUSE' : 'OFFSCREEN_RESUME',
    });
    if (!res?.ok) {
      return {
        ok: false,
        error: humanError(res?.error ?? (wantPaused ? 'Pause failed' : 'Resume failed')),
      };
    }
    offscreenToggled = true;
    const toggledAtMs = Date.now();
    if (wantPaused) {
      await chrome.storage.local.set({
        captureState: nextState,
        capturePausedAtMs: toggledAtMs,
        lastError: null,
      });
    } else {
      const currentOrigin =
        typeof audioStartedAtMs === 'number' && Number.isFinite(audioStartedAtMs)
          ? audioStartedAtMs
          : undefined;
      const pauseStartedAtMs =
        typeof capturePausedAtMs === 'number' && Number.isFinite(capturePausedAtMs)
          ? capturePausedAtMs
          : undefined;
      const adjustedOrigin = captureOriginAfterResume(
        currentOrigin,
        pauseStartedAtMs,
        toggledAtMs,
      );
      await chrome.storage.local.set({
        captureState: nextState,
        capturePausedAtMs: null,
        ...(adjustedOrigin === undefined ? {} : { audioStartedAtMs: adjustedOrigin }),
        lastError: null,
      });
      if (typeof currentSessionId === 'string' && adjustedOrigin !== undefined) {
        await updateSession(currentSessionId, { audioStartedAtMs: adjustedOrigin }).catch(() => {});
      }
    }
    if (typeof capturedTabId === 'number') void refreshActionBadge(capturedTabId);
    void refreshActiveTabBadge();
    return { ok: true };
  } catch (e) {
    if (offscreenToggled) {
      await sendToOffscreen({
        target: 'offscreen',
        type: wantPaused ? 'OFFSCREEN_RESUME' : 'OFFSCREEN_PAUSE',
      }).catch(() => {});
    }
    return { ok: false, error: humanError(e) };
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
  if (!isCapturingState(captureState) || tabId !== capturedTabId) return;
  const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined;
  const res = await stopOffscreen(sessionId).catch(() => null);
  await completeSession(sessionId, statusFromOffscreenAck(res));
  await setIdle({
    lastError:
      res && !res.ok
        ? humanError(res.error ?? 'Stop failed')
        : res
          ? null
          : humanError('Offscreen failed'),
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
    const bootCaptureState = isCapturingState(captureState) ? 'recording' : captureState;
    if (bootShouldIdle(bootCaptureState, offscreenAlive)) {
      await setIdle();
    }
    const exceptId = bootExceptId(bootCaptureState, currentSessionId, offscreenAlive);
    const retainAudio = (await getSettings()).retainAudio;
    await failStaleRecordings(exceptId, retainAudio);
    await purgeExpiredArchivedSessions().catch(() => 0);
    void retryPendingIntelligence();
    void sweepRetainedAudio().catch(() => {});
    if (
      typeof currentSessionId === 'string' &&
      acceptsCaptionEvents(bootCaptureState) &&
      !bootShouldIdle(bootCaptureState, offscreenAlive)
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
        case 'PAUSE_CAPTURE':
          sendResponse(await handlePauseToggle(true));
          break;
        case 'RESUME_CAPTURE':
          sendResponse(await handlePauseToggle(false));
          break;
        case 'CHUNK_SAVED': {
          // Offscreen cannot use chrome.storage — the SW owns all state.
          const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
          if (typeof currentSessionId === 'string' && currentSessionId === msg.sessionId) {
            await chrome.storage.local.set({ chunkCount: msg.count });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'TRANSCRIPTION_ERROR':
          await persistLastTranscriptionError(msg.message);
          sendResponse({ ok: true });
          break;
        case 'SEGMENT_SAVED': {
          const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
          if (typeof currentSessionId !== 'string' || currentSessionId !== msg.sessionId) {
            sendResponse({ ok: true });
            break;
          }
          await chrome.storage.local.set({ transcribedCount: msg.chunkIndex + 1 });
          await syncSegmentCount(currentSessionId);
          await applyFusion(currentSessionId).catch(() => {});
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
              lastError: msg.error ? humanError(msg.error) : null,
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
          await markIntelligencePending(msg.sessionId, settings);
          await runFinalizeIntelligence(msg.sessionId, settings, msg.templateId, { notify: false });
          const row = await getSession(msg.sessionId);
          if (row?.intelligence === 'needs-permission') {
            sendResponse({ ok: false, error: 'needs-permission' });
            break;
          }
          sendResponse({ ok: true });
          break;
        }
        case 'CHAT_ASK': {
          const settings = await getSettings();
          sendResponse(
            await answerTranscriptQuestion(msg.sessionId, msg.question, msg.history, settings),
          );
          break;
        }
        case 'LIBRARY_ASK': {
          const settings = await getSettings();
          sendResponse(await answerLibraryQuestion(msg.question, settings));
          break;
        }
        case 'EXPORT_ACTIONS': {
          sendResponse(await exportSelectedActionItems(msg.sessionId, msg.itemIds));
          break;
        }
        case 'ADD_HIGHLIGHT': {
          const { currentSessionId, captureState, audioStartedAtMs } = await chrome.storage.local.get([
            'currentSessionId',
            'captureState',
            'audioStartedAtMs',
          ]);
          const startMs = liveHighlightStartMs(
            captureState,
            typeof currentSessionId === 'string' ? currentSessionId : undefined,
            msg.sessionId,
            audioStartedAtMs,
          );
          if (startMs == null) {
            sendResponse({ ok: false, error: 'No recording is active' });
            break;
          }
          await putHighlight({
            id: crypto.randomUUID(),
            sessionId: msg.sessionId,
            startMs,
            label: normalizeHighlightLabel(msg.label),
            kind: normalizeHighlightKind(msg.kind),
            createdAt: new Date().toISOString(),
          });
          notifySidePanel({
            target: 'sidepanel',
            type: 'HIGHLIGHT_ADDED',
            sessionId: msg.sessionId,
          });
          sendResponse({ ok: true });
          break;
        }
        case 'RENAME_SPEAKER': {
          const result = await sessionMutationQueue.run(msg.sessionId, async () => {
            const session = await getSession(msg.sessionId);
            if (!session) return { ok: false, error: 'Session not found' } satisfies Ack;
            const from = msg.from.trim();
            const to = msg.to.trim();
            if (!from || !to) {
              return { ok: false, error: 'Speaker name cannot be empty' } satisfies Ack;
            }
            // Rewrite stored segments so search, exports, and the LLM see the new name.
            // The read and alias-map update are in the same session queue as fusion
            // and captions-only writes, so an older in-flight write cannot restore
            // the pre-rename speaker after this transaction completes.
            const segs = await getSegments(msg.sessionId);
            const renamedState = renameStoredSpeaker(segs, session.speakerNames, from, to);
            const renamed = renamedState.segments;
            if (renamed.some((s, i) => s.speaker !== segs[i]?.speaker)) {
              await putSegments(renamed);
              notifySidePanel({
                target: 'sidepanel',
                type: 'SEGMENTS_UPDATED',
                sessionId: msg.sessionId,
                segments: renamed,
              });
            }
            // Caption cues keep the raw Meet label; new persisted segments receive
            // the alias map before they are broadcast or indexed.
            await updateSession(msg.sessionId, { speakerNames: renamedState.speakerNames });
            return { ok: true } satisfies Ack;
          });
          sendResponse(result);
          break;
        }
        case 'RENAME_SESSION': {
          const result = await sessionMutationQueue.run(msg.sessionId, async () => {
            const title = msg.title.trim().slice(0, 200);
            if (!title) return { ok: false, error: 'Title cannot be empty' } satisfies Ack;
            await updateSession(msg.sessionId, { title });
            return { ok: true } satisfies Ack;
          });
          sendResponse(result);
          break;
        }
        case 'ARCHIVE_SESSION': {
          const result = await sessionMutationQueue.run(msg.sessionId, async () => {
            const session = await getSession(msg.sessionId);
            if (!session) return { ok: false, error: 'Session not found' } satisfies Ack;
            if (session.status === 'recording') {
              return { ok: false, error: 'Stop the recording before archiving it' } satisfies Ack;
            }
            await archiveSession(msg.sessionId);
            return { ok: true } satisfies Ack;
          });
          sendResponse(result);
          break;
        }
        case 'RESTORE_SESSION': {
          const result = await sessionMutationQueue.run(msg.sessionId, async () => {
            const session = await getSession(msg.sessionId);
            if (!session) return { ok: false, error: 'Session not found' } satisfies Ack;
            await restoreSession(msg.sessionId);
            return { ok: true } satisfies Ack;
          });
          sendResponse(result);
          break;
        }
        case 'EDIT_SEGMENT': {
          const result = await sessionMutationQueue.run(msg.sessionId, async () => {
            const text = msg.text.trim();
            if (!text) {
              return { ok: false, error: 'Transcript text cannot be empty' } satisfies Ack;
            }
            const settings = await getSettings();
            const updated = await editSessionSegment(
              msg.sessionId,
              msg.segmentId,
              text,
              undefined,
              settings.redactAtRest ? { extraTerms: settings.redactTerms } : null,
            );
            notifySidePanel({
              target: 'sidepanel',
              type: 'SEGMENTS_UPDATED',
              sessionId: msg.sessionId,
              segments: [updated],
            });
            return { ok: true } satisfies Ack;
          });
          sendResponse(result);
          break;
        }
        case 'IMPORT_TRANSCRIPT': {
          const importSettings = await getSettings();
          const imported = await importTranscriptSession(
            msg.name,
            msg.content,
            importSettings.redactAtRest ? { extraTerms: importSettings.redactTerms } : null,
          );
          if ('error' in imported) {
            sendResponse({ ok: false, error: imported.error });
            break;
          }
          const segments = await getSegments(imported.sessionId);
          notifySidePanel({
            target: 'sidepanel',
            type: 'SEGMENTS_UPDATED',
            sessionId: imported.sessionId,
            segments,
          });
          sendResponse({ ok: true, sessionId: imported.sessionId });
          break;
        }
        case 'SYNC_ALL': {
          const { captureState } = await chrome.storage.local.get('captureState');
          if (isLiveCaptureState(captureState)) {
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
            warning: last.warning,
            hostMissing: last.state === 'missing',
          } satisfies Ack);
          break;
        }
      }
    })().catch((e) => sendResponse({ ok: false, error: humanError(e) }));
    return true;
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command === COMMAND_OPEN_SIDE_PANEL) {
      // sidePanel.open must run in the user-gesture turn — no await first.
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const queryErr = chrome.runtime.lastError?.message;
        if (queryErr) {
          void surfaceCommandError(humanError(queryErr));
          return;
        }
        const windowId = tabs[0]?.windowId;
        if (windowId == null) {
          void surfaceCommandError('No active tab to record.');
          return;
        }
        try {
          const opened = chrome.sidePanel.open({ windowId });
          void Promise.resolve(opened).catch((e) => {
            void surfaceCommandError(humanError(e));
          });
        } catch (e) {
          void surfaceCommandError(humanError(e));
        }
      });
      return;
    }
    void bootReady.then(async () => {
      try {
        if (command === COMMAND_START_CAPTURE) {
          const res = await handleStart();
          if (!res.ok) void surfaceCommandError(res.error ?? GENERIC_USER_ERROR);
          return;
        }
        if (command === COMMAND_STOP_CAPTURE) {
          const res = await handleStop();
          if (!res.ok) void surfaceCommandError(res.error ?? GENERIC_USER_ERROR);
          return;
        }
        if (command === COMMAND_ADD_HIGHLIGHT) {
          const { currentSessionId, captureState } = await chrome.storage.local.get([
            'currentSessionId',
            'captureState',
          ]);
          if (captureState !== 'recording' || typeof currentSessionId !== 'string') {
            void surfaceCommandError('No recording is active.');
            return;
          }
          const { audioStartedAtMs } = await chrome.storage.local.get('audioStartedAtMs');
          const startMs = liveHighlightStartMs(
            captureState,
            typeof currentSessionId === 'string' ? currentSessionId : undefined,
            currentSessionId,
            audioStartedAtMs,
          );
          if (startMs == null) {
            void surfaceCommandError('No recording is active.');
            return;
          }
          await putHighlight({
            id: crypto.randomUUID(),
            sessionId: currentSessionId,
            startMs,
            createdAt: new Date().toISOString(),
          });
          notifySidePanel({
            target: 'sidepanel',
            type: 'HIGHLIGHT_ADDED',
            sessionId: currentSessionId,
          });
        }
      } catch (e) {
        void surfaceCommandError(humanError(e));
      }
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void bootReady.then(() => finalizeIfCaptured(tabId));
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'loading' || info.url !== undefined) {
      void bootReady.then(() => finalizeIfCaptured(tabId));
    }
    void refreshActionBadge(tabId, info.url ?? tab.url);
  });

  chrome.tabs.onActivated.addListener((info) => {
    void refreshActionBadge(info.tabId);
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void refreshActiveTabBadge();
  });

  void refreshActiveTabBadge();
});
