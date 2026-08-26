import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Ack, CaptureState } from '@/utils/messages';
import { assembleRecording } from '@/utils/assemble';

function App() {
  const [state, setState] = useState<CaptureState>('idle');
  const [chunks, setChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get(['captureState', 'chunkCount']).then((v) => {
      setState((v.captureState as CaptureState) ?? 'idle');
      setChunks((v.chunkCount as number) ?? 0);
    });
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.chunkCount) setChunks((c.chunkCount.newValue as number) ?? 0);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const send = async (type: 'START_CAPTURE' | 'STOP_CAPTURE') => {
    setError(null);
    const res = (await chrome.runtime.sendMessage({ target: 'background', type })) as Ack;
    if (!res?.ok) setError(res?.error ?? 'Unknown error');
  };

  const download = async () => {
    setError(null);
    try {
      const { blob, seconds } = await assembleRecording();
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `scribetab-recording-${Math.round(seconds)}s.wav`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = state === 'starting' || state === 'stopping';
  return (
    <main style={{ minWidth: 260, padding: 12, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 16, margin: '0 0 8px' }}>ScribeTab</h1>
      {state === 'recording' || state === 'stopping' ? (
        <button disabled={busy} onClick={() => send('STOP_CAPTURE')}>■ Stop recording</button>
      ) : (
        <button disabled={busy} onClick={() => send('START_CAPTURE')}>● Start recording this tab</button>
      )}
      <p data-testid="chunk-count" style={{ fontSize: 12, color: '#555' }}>
        Saved chunks: {chunks}
      </p>
      <button onClick={download} disabled={state !== 'idle'}>
        Download last recording (.wav)
      </button>
      {error && <p style={{ color: 'crimson', fontSize: 12 }}>{error}</p>}
    </main>
  );
}
render(<App />, document.getElementById('app')!);
