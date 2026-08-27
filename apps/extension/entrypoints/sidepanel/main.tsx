import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TranscriptSegment } from '@scribetab/shared';
import type { CaptureState, ToSidePanel } from '@/utils/messages';
import { getSegments } from '@/utils/segmentStore';

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function App() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [configured, setConfigured] = useState(true);
  const [micStatus, setMicStatus] = useState<string>('off');
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
    void chrome.storage.local
      .get(['currentSessionId', 'captureState', 'transcriptionConfigured', 'micStatus'])
      .then(async (v) => {
        setState((v.captureState as CaptureState) ?? 'idle');
        setConfigured((v.transcriptionConfigured as boolean) ?? true);
        setMicStatus((v.micStatus as string) ?? 'off');
        const sid = (v.currentSessionId as string) ?? null;
        setSessionId(sid);
        if (sid) setSegments(await getSegments(sid));
      });

    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.transcriptionConfigured) setConfigured(Boolean(c.transcriptionConfigured.newValue));
      if (c.micStatus) setMicStatus(String(c.micStatus.newValue ?? 'off'));
      if (c.currentSessionId) {
        const sid = (c.currentSessionId.newValue as string) ?? null;
        setSessionId(sid);
        setSegments([]);
        if (sid) void getSegments(sid).then(setSegments);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);

    const onMessage = (raw: unknown) => {
      const msg = raw as ToSidePanel;
      if (msg?.target !== 'sidepanel' || msg.type !== 'SEGMENTS_ADDED') return;
      if (sessionRef.current && msg.sessionId !== sessionRef.current) return;
      setSegments((prev) =>
        [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs),
      );
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [segments.length]);

  return (
    <main style={{ padding: 12, fontFamily: 'system-ui', fontSize: 14 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>Transcript</h1>
        <span style={{ fontSize: 12, color: state === 'recording' ? 'crimson' : '#555' }}>
          {state === 'recording' ? '● recording' : state}
          {micStatus === 'denied' && ' · mic denied — tab audio only'}
        </span>
      </header>

      {!configured && (
        <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 13 }}>
          No transcription provider configured (or its permission is missing) — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Open settings
          </a>
        </p>
      )}

      {segments.length === 0 ? (
        <p style={{ color: '#777' }}>Segments appear here as chunks are transcribed.</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
          {segments.map((s) => (
            <li key={s.id} style={{ margin: '6px 0' }}>
              <span style={{ color: '#999', fontSize: 11, marginRight: 6 }}>{fmt(s.startMs)}</span>
              <span style={s.text === '[transcription failed]' ? { color: 'crimson' } : undefined}>
                {s.text}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div ref={endRef} />
    </main>
  );
}

render(<App />, document.getElementById('app')!);
