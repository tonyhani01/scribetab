import { useEffect, useRef, useState } from 'preact/hooks';
import type { HighlightKind, TranscriptSegment } from '@scribetab/shared';
import { HIGHLIGHT_KIND_EMOJI } from '@scribetab/shared';
import { ConsentBanner } from '@/components/ConsentBanner';
import type { Ack, CaptureState, ToSidePanel, TranscriptionIssue } from '@/utils/messages';
import { type NativeHostStatus } from '@/utils/nativeSync';
import { getSegments } from '@/utils/segmentStore';
import { humanError } from '@/utils/userError';
import { addPending, clearPending, resolveBelow, resolvePending, type PendingChunk } from '@/utils/pendingChunks';
import { canApplySessionRead, type SessionReadToken } from '@/utils/sessionReadGuard';
import { mergeSegments } from '@/utils/segmentMerge';
import { ChatView } from './ChatView';
import { SegmentList } from './SegmentList';
import { openSettingsWindow } from '@/utils/settingsWindow';

/** The four flag buttons shown while recording, in display order. */
const HIGHLIGHT_BUTTONS: readonly { kind: HighlightKind; title: string; added: string }[] = [
  { kind: 'highlight', title: 'Add highlight', added: 'Highlight added' },
  { kind: 'action', title: 'Add action item', added: 'Action added' },
  { kind: 'decision', title: 'Add decision', added: 'Decision added' },
  { kind: 'question', title: 'Add question', added: 'Question added' },
];

export function LiveView() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [configured, setConfigured] = useState(true);
  const [issue, setIssue] = useState<TranscriptionIssue>(null);
  const [lastTranscriptionError, setLastTranscriptionError] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<string>('off');
  const [hostStatus, setHostStatus] = useState<NativeHostStatus>({ state: 'idle' });
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [highlightBusy, setHighlightBusy] = useState(false);
  const [highlightStatus, setHighlightStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<PendingChunk[]>([]);
  const [pane, setPane] = useState<'transcript' | 'ask'>('transcript');
  const [transcribedCount, setTranscribedCount] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  const sessionReadRef = useRef<{ currentSessionId: string | null; version: number }>({
    currentSessionId: null,
    version: 0,
  });
  const highlightTimerRef = useRef<number | undefined>(undefined);
  sessionRef.current = sessionId;

  const selectSession = (id: string | null): number => {
    const next = { currentSessionId: id, version: sessionReadRef.current.version + 1 };
    sessionReadRef.current = next;
    sessionRef.current = id;
    return next.version;
  };

  const loadSessionSegments = (id: string, version: number) => {
    const token: SessionReadToken = { sessionId: id, version };
    void getSegments(id).then((rows) => {
      const current = sessionReadRef.current;
      if (canApplySessionRead(token, current.currentSessionId, current.version)) {
        setSegments((prev) => mergeSegments(rows, prev));
      }
    });
  };

  useEffect(() => {
    const initialVersion = sessionReadRef.current.version;
    void chrome.storage.local
      .get(['currentSessionId', 'captureState', 'transcriptionConfigured', 'transcriptionIssue', 'lastTranscriptionError', 'micStatus', 'nativeHostStatus', 'captureNotice', 'transcribedCount', 'chunkCount'])
      .then(async (v) => {
        const capture = (v.captureState as CaptureState) ?? 'idle';
        const count = typeof v.transcribedCount === 'number' ? v.transcribedCount : 0;
        setState(capture);
        setConfigured((v.transcriptionConfigured as boolean) ?? true);
        setTranscribedCount(count);
        setChunkCount(typeof v.chunkCount === 'number' ? v.chunkCount : 0);
        if (capture === 'idle') {
          setPending(clearPending());
        } else {
          setPending((prev) => resolveBelow(prev, count));
        }
        setIssue((v.transcriptionIssue as TranscriptionIssue) ?? null);
        setLastTranscriptionError(
          typeof v.lastTranscriptionError === 'string' && v.lastTranscriptionError
            ? v.lastTranscriptionError
            : null,
        );
        setMicStatus((v.micStatus as string) ?? 'off');
        if (v.nativeHostStatus) setHostStatus(v.nativeHostStatus as NativeHostStatus);
        setNotice(typeof v.captureNotice === 'string' && v.captureNotice ? v.captureNotice : null);
        if (sessionReadRef.current.version !== initialVersion) return;
        const sid = (v.currentSessionId as string) ?? null;
        const version = selectSession(sid);
        setSessionId(sid);
        if (sid) loadSessionSegments(sid, version);
      });

    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) {
        const next = (c.captureState.newValue as CaptureState) ?? 'idle';
        setState(next);
        if (next === 'idle') setPending(clearPending());
      }
      if (c.transcriptionConfigured) setConfigured(Boolean(c.transcriptionConfigured.newValue));
      if ('transcriptionIssue' in c) setIssue((c.transcriptionIssue.newValue as TranscriptionIssue) ?? null);
      if ('lastTranscriptionError' in c) {
        const err = c.lastTranscriptionError.newValue;
        setLastTranscriptionError(typeof err === 'string' && err ? err : null);
      }
      if (c.micStatus) setMicStatus(String(c.micStatus.newValue ?? 'off'));
      if (c.nativeHostStatus) setHostStatus((c.nativeHostStatus.newValue as NativeHostStatus) ?? { state: 'idle' });
      if (c.captureNotice) {
        const n = c.captureNotice.newValue;
        setNotice(typeof n === 'string' && n ? n : null);
      }
      if ('transcribedCount' in c) {
        const count = typeof c.transcribedCount.newValue === 'number' ? c.transcribedCount.newValue : 0;
        setTranscribedCount(count);
        setPending((prev) => resolveBelow(prev, count));
      }
      if ('chunkCount' in c) setChunkCount(typeof c.chunkCount.newValue === 'number' ? c.chunkCount.newValue : 0);
      if (c.currentSessionId) {
        const sid = (c.currentSessionId.newValue as string) ?? null;
        const version = selectSession(sid);
        setSessionId(sid);
        setSegments([]);
        setPending(clearPending());
        if (sid) loadSessionSegments(sid, version);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);

    const onMessage = (raw: unknown) => {
      const msg = raw as ToSidePanel;
      if (msg?.target !== 'sidepanel') return;
      if (sessionRef.current && msg.sessionId !== sessionRef.current) return;
      if (msg.type === 'CHUNK_TRANSCRIBING') {
        if (!sessionRef.current || msg.sessionId !== sessionRef.current) return;
        setPending((prev) =>
          addPending(prev, {
            chunkIndex: msg.chunkIndex,
            startMs: msg.startMs,
            durationMs: msg.durationMs,
            startedAt: Date.now(),
          }),
        );
      } else if (msg.type === 'SEGMENTS_ADDED') {
        if (!sessionRef.current || msg.sessionId !== sessionRef.current) return;
        setSegments((prev) => mergeSegments(prev, msg.segments));
        const chunkIndex = msg.chunkIndex;
        if (typeof chunkIndex === 'number') setPending((prev) => resolvePending(prev, chunkIndex));
      } else if (msg.type === 'SEGMENTS_UPDATED') {
        if (!sessionRef.current || msg.sessionId !== sessionRef.current) return;
        setSegments((prev) => mergeSegments(prev, msg.segments));
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
      if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [segments.length, pending.length]);

  const sendCapture = async (
    type: 'START_CAPTURE' | 'PAUSE_CAPTURE' | 'RESUME_CAPTURE' | 'STOP_CAPTURE',
  ) => {
    if (commandBusy || state === 'starting' || state === 'stopping') return;
    setCaptureError(null);
    setCommandBusy(true);
    try {
      const res = (await chrome.runtime.sendMessage({ target: 'background', type })) as Ack;
      if (!res?.ok) setCaptureError(res?.error ?? humanError('Capture failed'));
    } catch (e) {
      setCaptureError(humanError(e));
    } finally {
      setCommandBusy(false);
    }
  };

  const addHighlight = async (kind: HighlightKind) => {
    if (!sessionId || state !== 'recording' || highlightBusy) return;
    const added = HIGHLIGHT_BUTTONS.find((b) => b.kind === kind)?.added ?? 'Highlight added';
    setHighlightBusy(true);
    setHighlightStatus(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'ADD_HIGHLIGHT',
        sessionId,
        kind,
      })) as Ack;
      setHighlightStatus(res?.ok ? { ok: true, text: added } : { ok: false, text: res?.error ?? 'Could not add highlight' });
    } catch (e) {
      setHighlightStatus({ ok: false, text: humanError(e) });
    } finally {
      setHighlightBusy(false);
      if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => setHighlightStatus(null), 2500);
    }
  };

  const captureBusy = commandBusy || state === 'starting' || state === 'stopping';
  return (
    <section>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>Transcript</h1>
        <span class={state === 'recording' ? 'st-pill st-pill--rec' : 'st-pill'}>
          {state === 'recording' && <span class="st-dot" />}
          {state}
          {micStatus === 'denied' && ' · mic denied — tab audio only'}
        </span>
      </header>

      <ConsentBanner recording={state === 'recording' || state === 'paused' || state === 'starting' || state === 'stopping'} />
      {captureError && <p data-testid="live-capture-error" class="st-banner st-banner--error">{captureError}</p>}
      {notice && <p class="st-banner st-banner--warn">{notice}</p>}
      {!configured && issue === 'missing-permission' && (
        <p data-testid="live-permission" class="st-banner st-banner--warn">
          Host permission for the transcription provider is missing — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void openSettingsWindow(); }}>Open settings</a>
        </p>
      )}
      {!configured && issue !== 'missing-permission' && (
        <p data-testid="live-unconfigured" class="st-banner st-banner--warn">
          No transcription provider configured — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void openSettingsWindow(); }}>Open settings</a>
        </p>
      )}
      {lastTranscriptionError && (
        <p data-testid="live-transcription-error" class="st-banner st-banner--error">{lastTranscriptionError}</p>
      )}

      <div class="st-capture-controls">
        {state === 'recording' || state === 'paused' || state === 'stopping' ? (
          <>
            {state !== 'stopping' && (
              <button
                type="button"
                class="st-btn st-btn--quiet"
                disabled={captureBusy}
                onClick={() => void sendCapture(state === 'paused' ? 'RESUME_CAPTURE' : 'PAUSE_CAPTURE')}
              >
                {state === 'paused' ? 'Resume recording' : 'Pause recording'}
              </button>
            )}
            <button
              type="button"
              class="st-btn st-btn--danger"
              disabled={captureBusy}
              onClick={() => void sendCapture('STOP_CAPTURE')}
            >
              {state === 'stopping' ? 'Stopping…' : 'Stop recording'}
            </button>
          </>
        ) : (
          <button
            type="button"
            class="st-btn"
            disabled={captureBusy}
            onClick={() => void sendCapture('START_CAPTURE')}
          >
            {state === 'starting' ? 'Starting…' : 'Start recording'}
          </button>
        )}
        {HIGHLIGHT_BUTTONS.map(({ kind, title }) => (
          <button
            key={kind}
            type="button"
            class="st-chip"
            title={title}
            aria-label={title}
            disabled={captureBusy || highlightBusy || state !== 'recording' || !sessionId}
            onClick={() => void addHighlight(kind)}
          >
            {HIGHLIGHT_KIND_EMOJI[kind]}
          </button>
        ))}
      </div>
      {highlightStatus && <p class={highlightStatus.ok ? 'st-status-text' : 'st-status-text st-status-text--error'} aria-live="polite">{highlightStatus.text}</p>}

      {sessionId && (
        <nav class="st-seg" style={{ margin: '10px 0' }}>
          {(['transcript', 'ask'] as const).map((p) => (
            <button key={p} type="button" aria-selected={pane === p} onClick={() => setPane(p)}>
              {p === 'ask' ? 'Ask' : 'Transcript'}
            </button>
          ))}
        </nav>
      )}
      {pane === 'ask' && sessionId ? (
        <ChatView key={sessionId} sessionId={sessionId} />
      ) : state === 'idle' && segments.length === 0 && pending.length === 0 ? (
        <p data-testid="live-empty" class="st-empty">No live session. Start recording from the popup or press Alt+Shift+R.</p>
      ) : (
        <SegmentList segments={segments} pending={pending} empty="Segments appear here as chunks are transcribed." />
      )}
      {pane !== 'ask' && state === 'recording' && (
        <p class="st-hint st-livestatus">
          {transcribedCount < chunkCount
            ? `Transcribing chunk ${Math.min(transcribedCount + 1, chunkCount)} of ${chunkCount}`
            : 'Listening…'}
        </p>
      )}
      {state === 'paused' && <p class="st-hint st-livestatus">Paused</p>}
      {state === 'stopping' && transcribedCount < chunkCount && (
        <p class="st-hint st-livestatus">Finishing transcription… {transcribedCount} / {chunkCount}</p>
      )}
      <div ref={endRef} />

      <footer style={{ marginTop: 16, borderTop: '1px solid var(--st-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        <button
          class="st-btn st-btn--quiet"
          disabled={syncing || state === 'recording' || state === 'paused' || state === 'starting' || state === 'stopping'}
          onClick={() => {
            setSyncing(true);
            void chrome.runtime
              .sendMessage({ target: 'background', type: 'SYNC_ALL' })
              .then((res: Ack) => {
                if (res?.hostMissing) setHostStatus({ state: 'missing', message: res.error });
                else if (!res?.ok) setHostStatus({ state: 'error', message: res?.error ?? humanError('Sync failed') });
                else setHostStatus({ state: 'ok', warning: res.warning });
              })
              .catch((e) => setHostStatus({ state: 'error', message: humanError(e) }))
              .finally(() => setSyncing(false));
          }}
        >
          {syncing ? 'Syncing…' : 'Sync all'}
        </button>
        {hostStatus.state === 'missing' && (
          <p class="st-banner st-banner--warn">
            Native host not installed. Run <code>node apps/native-host/dist/host.bin.js install</code>{' '}
            (npm package planned) then try Sync all.
          </p>
        )}
        {hostStatus.state === 'error' && hostStatus.message && <p data-testid="sync-error" class="st-banner st-banner--error">{hostStatus.message}</p>}
        {hostStatus.state === 'ok' && <p class="st-ok-text">Synced to ~/ScribeTab/meetings</p>}
        {hostStatus.state === 'ok' && hostStatus.warning && <p class="st-banner st-banner--warn">Integrations: {hostStatus.warning}</p>}
      </footer>
    </section>
  );
}
