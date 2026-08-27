import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ConsentBanner } from '@/components/ConsentBanner';
import type { Ack, CaptureState } from '@/utils/messages';
import { assembleRecording } from '@/utils/assemble';
import { isCapturableUrl } from '@/utils/platform';
import { listSessions } from '@/utils/sessionStore';
import { monthlySpend, type MonthlySpend } from '@/utils/costMeter';
import { formatUsd } from '@scribetab/shared';
import { humanError } from '@/utils/userError';
import '@/assets/theme.css';

function MicIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function App() {
  const [state, setState] = useState<CaptureState>('idle');
  const [chunks, setChunks] = useState(0);
  const [transcribed, setTranscribed] = useState(0);
  const [transcriptionOn, setTranscriptionOn] = useState(false);
  const [sessionCaptionsOnly, setSessionCaptionsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturable, setCapturable] = useState(true);
  const [spend, setSpend] = useState<MonthlySpend | null>(null);

  const refreshSpend = () => {
    void listSessions()
      .then((rows) => setSpend(monthlySpend(rows)))
      .catch(() => setSpend(null));
  };

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setCapturable(isCapturableUrl(tab?.url));
    });
    refreshSpend();
    chrome.storage.local.get(['captureState', 'chunkCount', 'transcribedCount', 'transcriptionConfigured', 'sessionCaptionsOnly', 'lastError', 'captureNotice']).then((v) => {
      setState((v.captureState as CaptureState) ?? 'idle');
      setChunks((v.chunkCount as number) ?? 0);
      setTranscribed((v.transcribedCount as number) ?? 0);
      setTranscriptionOn(Boolean(v.transcriptionConfigured));
      setSessionCaptionsOnly(Boolean(v.sessionCaptionsOnly));
      if (typeof v.lastError === 'string' && v.lastError) setError(v.lastError);
      if (typeof v.captureNotice === 'string' && v.captureNotice) setNotice(v.captureNotice);
    });
    const onChange = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) {
        setState((c.captureState.newValue as CaptureState) ?? 'idle');
        if (c.captureState.newValue === 'idle') refreshSpend();
      }
      if (c.chunkCount) setChunks((c.chunkCount.newValue as number) ?? 0);
      if (c.transcribedCount) setTranscribed((c.transcribedCount.newValue as number) ?? 0);
      if (c.transcriptionConfigured) setTranscriptionOn(Boolean(c.transcriptionConfigured.newValue));
      if (c.sessionCaptionsOnly) setSessionCaptionsOnly(Boolean(c.sessionCaptionsOnly.newValue));
      if (c.lastError?.newValue) setError(String(c.lastError.newValue));
      if (c.captureNotice) {
        const n = c.captureNotice.newValue;
        setNotice(typeof n === 'string' && n ? n : null);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const send = async (type: 'START_CAPTURE' | 'STOP_CAPTURE') => {
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ target: 'background', type })) as Ack;
      if (!res?.ok) setError(res?.error ?? humanError('Unknown error'));
    } catch (e) {
      setError(humanError(e));
    }
  };

  const download = async () => {
    setError(null);
    try {
      const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
      if (typeof currentSessionId !== 'string' || !currentSessionId) {
        throw new Error('Nothing recorded yet');
      }
      const { blob, seconds, ext } = await assembleRecording(currentSessionId);
      const url = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({
        url,
        filename: `scribetab-recording-${Math.round(seconds)}s.${ext}`,
      });
      const done = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
          URL.revokeObjectURL(url);
          chrome.downloads.onChanged.removeListener(done);
        }
      };
      chrome.downloads.onChanged.addListener(done);
    } catch (e) {
      setError(humanError(e));
    }
  };

  const busy = state === 'starting' || state === 'stopping';
  const recording = state === 'recording' || state === 'starting' || state === 'stopping';
  const stopping = state === 'recording' || state === 'stopping';
  const showTranscribed = recording && transcriptionOn && !sessionCaptionsOnly;
  return (
    <main data-testid="popup-root" style={{ width: 340, display: 'flex', flexDirection: 'column' }}>
      <header class="st-header">
        <div class="st-brand">
          <img src="/icon-48.png" alt="" />
          <h1 class="st-wordmark" aria-label="ScribeTab" style={{ margin: 0 }}>
            scribe<b>Tab</b>
          </h1>
        </div>
        <div style={{ flexGrow: 1 }} />
        <button
          type="button"
          class="st-chip"
          aria-label="Settings"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.03-1.55V3.5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.05Z" />
          </svg>
        </button>
      </header>

      <div class="st-hero">
        {stopping ? (
          <button
            type="button"
            class="st-record st-record--recording"
            disabled={busy}
            onClick={() => send('STOP_CAPTURE')}
          >
            <StopIcon />
            Stop
          </button>
        ) : (
          <button
            type="button"
            class="st-record"
            disabled={busy || (!capturable && !recording)}
            onClick={() => send('START_CAPTURE')}
          >
            <MicIcon />
            Record
          </button>
        )}
        <span class="st-status">
          {stopping
            ? 'Recording this tab'
            : state === 'starting'
              ? 'Starting…'
              : capturable
                ? 'Ready to record this tab'
                : ''}
        </span>
      </div>

      {!capturable && !recording && (
        <div class="st-body" style={{ paddingTop: 0 }}>
          <p data-testid="not-capturable" class="st-banner st-banner--warn">
            This page cannot be recorded. Open a meeting tab (Meet, Teams, Zoom, YouTube) or any
            http(s) page, then try again.
          </p>
        </div>
      )}

      <div class="st-body" style={{ paddingTop: 0 }}>
        <ConsentBanner recording={recording} />
        <div class="st-row">
          <span>{showTranscribed ? 'Transcribed' : 'Saved chunks'}</span>
          <span data-testid="chunk-count" class="st-meta">
            {showTranscribed ? `${transcribed} / ${chunks} chunks` : chunks}
          </span>
        </div>
        {spend !== null && spend.sessionCount > 0 && (
          <div class="st-row" data-testid="month-spend" title="Estimated from provider list prices">
            <span>Spend this month</span>
            <span class="st-meta">
              {formatUsd(spend.totalUsd)} est. · {spend.sessionCount}{' '}
              {spend.sessionCount === 1 ? 'session' : 'sessions'}
            </span>
          </div>
        )}
        {notice && <p class="st-banner st-banner--warn">{notice}</p>}
        {error && (
          <div data-testid="popup-error" class="st-banner st-banner--error">
            <p style={{ margin: '0 0 8px' }}>{error}</p>
            <button
              type="button"
              class="st-chip"
              data-testid="popup-error-dismiss"
              onClick={() => {
                setError(null);
                void chrome.storage.local.set({ lastError: null });
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      <footer class="st-footer">
        <button
          type="button"
          class="st-btn st-btn--navy st-btn--block"
          data-testid="open-side-panel"
          onClick={() => {
            chrome.windows.getCurrent((w) => {
              if (w.id != null) void chrome.sidePanel.open({ windowId: w.id });
              window.close();
            });
          }}
        >
          Open transcript panel
        </button>
        <button type="button" class="st-btn st-btn--quiet st-btn--block" onClick={download} disabled={state !== 'idle'}>
          Download recording
        </button>
      </footer>
    </main>
  );
}
render(<App />, document.getElementById('app')!);
