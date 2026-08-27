import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ConsentBanner } from '@/components/ConsentBanner';
import type { Ack, CaptureState } from '@/utils/messages';
import { assembleRecording } from '@/utils/assemble';
import { isCapturableUrl } from '@/utils/platform';
import { humanError } from '@/utils/userError';

function App() {
  const [state, setState] = useState<CaptureState>('idle');
  const [chunks, setChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturable, setCapturable] = useState(true);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setCapturable(isCapturableUrl(tab?.url));
    });
    chrome.storage.local.get(['captureState', 'chunkCount', 'lastError', 'captureNotice']).then((v) => {
      setState((v.captureState as CaptureState) ?? 'idle');
      setChunks((v.chunkCount as number) ?? 0);
      if (typeof v.lastError === 'string' && v.lastError) setError(humanError(v.lastError));
      if (typeof v.captureNotice === 'string' && v.captureNotice) setNotice(v.captureNotice);
    });
    const onChange = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.chunkCount) setChunks((c.chunkCount.newValue as number) ?? 0);
      if (c.lastError?.newValue) setError(humanError(c.lastError.newValue));
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
      if (!res?.ok) setError(humanError(res?.error ?? 'Unknown error'));
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
      const { blob, seconds } = await assembleRecording(currentSessionId);
      const url = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({
        url,
        filename: `scribetab-recording-${Math.round(seconds)}s.wav`,
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
  return (
    <main data-testid="popup-root" style={{ minWidth: 260, padding: 12, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 16, margin: '0 0 8px' }}>ScribeTab</h1>
      {!capturable && !recording ? (
        <p data-testid="not-capturable" style={{ fontSize: 13, color: '#555' }}>
          This page cannot be recorded. Open a meeting tab (Meet, Teams, Zoom, YouTube) or any
          http(s) page, then try again.
        </p>
      ) : state === 'recording' || state === 'stopping' ? (
        <button disabled={busy} onClick={() => send('STOP_CAPTURE')}>
          ■ Stop recording
        </button>
      ) : (
        <button disabled={busy} onClick={() => send('START_CAPTURE')}>
          ● Start recording this tab
        </button>
      )}
      <ConsentBanner recording={recording} />
      <p data-testid="chunk-count" style={{ fontSize: 12, color: '#555' }}>
        Saved chunks: {chunks}
      </p>
      <button onClick={download} disabled={state !== 'idle'}>
        Download last recording (.wav)
      </button>
      <button
        data-testid="open-side-panel"
        onClick={() => {
          void chrome.windows.getCurrent().then((w) => {
            if (w.id != null) void chrome.sidePanel.open({ windowId: w.id });
            window.close();
          });
        }}
      >
        Open transcript panel
      </button>
      {notice && <p style={{ color: '#8a6d00', fontSize: 12 }}>{notice}</p>}
      {error && (
        <p data-testid="popup-error" style={{ color: 'crimson', fontSize: 12 }}>
          {error}
        </p>
      )}
    </main>
  );
}
render(<App />, document.getElementById('app')!);
