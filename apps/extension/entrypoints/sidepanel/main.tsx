import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { formatClock } from '@scribetab/shared';
import type MiniSearch from 'minisearch';
import type { Ack, CaptureState, ToSidePanel } from '@/utils/messages';
import type { NativeHostStatus } from '@/utils/nativeSync';
import { downloadExport, type ExportFormat } from '@/utils/exportDownload';
import { getAllSegments, getSegments } from '@/utils/segmentStore';
import { createSegmentIndex, snippetAround, type SearchDoc } from '@/utils/search';
import { listSessions } from '@/utils/sessionStore';

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function durationLabel(session: MeetingSession): string {
  if (session.status === 'recording') return 'recording';
  if (!session.endedAt) return '';
  const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${total % 60}s`;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString();
}

type Tab = 'live' | 'library';

function App() {
  const [tab, setTab] = useState<Tab>('live');
  const [quotaWarning, setQuotaWarning] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('quotaWarning').then((v) => setQuotaWarning(Boolean(v.quotaWarning)));
    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.quotaWarning) setQuotaWarning(Boolean(c.quotaWarning.newValue));
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  return (
    <main style={{ padding: 12, fontFamily: 'system-ui', fontSize: 14 }}>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        {(['live', 'library'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              fontWeight: tab === t ? 700 : 400,
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      {quotaWarning && (
        <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 13 }}>
          Storage is over 80% full. Oldest meeting audio is being removed; transcripts are kept.
        </p>
      )}
      {tab === 'live' ? <LiveView /> : <LibraryView />}
    </main>
  );
}

function LiveView() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [configured, setConfigured] = useState(true);
  const [micStatus, setMicStatus] = useState<string>('off');
  const [hostStatus, setHostStatus] = useState<NativeHostStatus>({ state: 'idle' });
  const [syncing, setSyncing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
    void chrome.storage.local
      .get(['currentSessionId', 'captureState', 'transcriptionConfigured', 'micStatus', 'nativeHostStatus'])
      .then(async (v) => {
        setState((v.captureState as CaptureState) ?? 'idle');
        setConfigured((v.transcriptionConfigured as boolean) ?? true);
        setMicStatus((v.micStatus as string) ?? 'off');
        if (v.nativeHostStatus) setHostStatus(v.nativeHostStatus as NativeHostStatus);
        const sid = (v.currentSessionId as string) ?? null;
        setSessionId(sid);
        if (sid) setSegments(await getSegments(sid));
      });

    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.transcriptionConfigured) setConfigured(Boolean(c.transcriptionConfigured.newValue));
      if (c.micStatus) setMicStatus(String(c.micStatus.newValue ?? 'off'));
      if (c.nativeHostStatus) setHostStatus((c.nativeHostStatus.newValue as NativeHostStatus) ?? { state: 'idle' });
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
    <section>
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

      <SegmentList segments={segments} empty="Segments appear here as chunks are transcribed." />
      <div ref={endRef} />

      <footer style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 8 }}>
        <button
          disabled={syncing || state === 'recording' || state === 'starting' || state === 'stopping'}
          onClick={() => {
            setSyncing(true);
            void chrome.runtime
              .sendMessage({ target: 'background', type: 'SYNC_ALL' })
              .then((res: Ack) => {
                if (res?.hostMissing) {
                  setHostStatus({ state: 'missing', message: res.error });
                } else if (!res?.ok) {
                  setHostStatus({ state: 'error', message: res?.error ?? 'Sync failed' });
                } else {
                  setHostStatus({ state: 'ok' });
                }
              })
              .finally(() => setSyncing(false));
          }}
        >
          {syncing ? 'Syncing…' : 'Sync all'}
        </button>
        {hostStatus.state === 'missing' && (
          <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 12 }}>
            Native host not installed. Run <code>npx scribetab-host install</code> then try Sync all.
          </p>
        )}
        {hostStatus.state === 'error' && hostStatus.message && (
          <p style={{ color: '#555', fontSize: 12 }}>{hostStatus.message}</p>
        )}
        {hostStatus.state === 'ok' && (
          <p style={{ color: 'green', fontSize: 12 }}>Synced to ~/ScribeTab/meetings</p>
        )}
      </footer>
    </section>
  );
}

function LibraryView() {
  const [sessions, setSessions] = useState<MeetingSession[]>([]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<MiniSearch<SearchDoc> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openSegments, setOpenSegments] = useState<TranscriptSegment[]>([]);
  const [busy, setBusy] = useState(false);
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = openId;

  const reload = async () => {
    const list = await listSessions();
    setSessions(list);
    const segs = await getAllSegments();
    const titles = new Map(list.map((s) => [s.id, s.title]));
    const docs: SearchDoc[] = segs.map((s) => ({
      id: s.id,
      sessionId: s.sessionId,
      startMs: s.startMs,
      text: s.text,
      sessionTitle: titles.get(s.sessionId) ?? 'Untitled meeting',
    }));
    setIndex(createSegmentIndex(docs));
  };

  useEffect(() => {
    void reload();

    const onMessage = (raw: unknown) => {
      const msg = raw as ToSidePanel;
      if (msg?.target !== 'sidepanel' || msg.type !== 'SEGMENTS_ADDED') return;
      void reload();
      if (openIdRef.current !== msg.sessionId) return;
      setOpenSegments((prev) =>
        [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs),
      );
    };
    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState && c.captureState.newValue === 'idle') void reload();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  const openSession = async (id: string) => {
    openIdRef.current = id;
    setOpenId(id);
    setOpenSegments([]);
    const segs = await getSegments(id);
    if (openIdRef.current === id) setOpenSegments(segs);
  };

  const hits = query.trim() && index ? index.search(query.trim()) : [];
  const open = sessions.find((s) => s.id === openId) ?? null;

  const exportOne = async (format: ExportFormat) => {
    if (!open) return;
    setBusy(true);
    try {
      await downloadExport(open, openSegments, format);
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <section>
        <button onClick={() => setOpenId(null)} style={{ marginBottom: 8 }}>
          ← Library
        </button>
        <h1 style={{ fontSize: 15, margin: '0 0 4px' }}>{open.title}</h1>
        <p style={{ fontSize: 12, color: '#555', margin: '0 0 8px' }}>
          {dateLabel(open.startedAt)} · {durationLabel(open)} · {open.platform} · {open.status}
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['md', 'json', 'srt', 'vtt'] as const).map((f) => (
            <button key={f} disabled={busy} onClick={() => void exportOne(f)}>
              Export .{f}
            </button>
          ))}
        </div>
        <SegmentList segments={openSegments} empty="No transcript segments for this meeting." />
      </section>
    );
  }

  return (
    <section>
      <h1 style={{ fontSize: 15, margin: '0 0 8px' }}>Library</h1>
      <input
        type="search"
        placeholder="Search transcripts…"
        value={query}
        onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        style={{ width: '100%', padding: 6, marginBottom: 10, boxSizing: 'border-box' }}
      />
      {query.trim() ? (
        hits.length === 0 ? (
          <p style={{ color: '#777' }}>No matches.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {hits.map((h) => (
              <li key={h.id} style={{ margin: '0 0 10px' }}>
                <button
                  onClick={() => void openSession(String(h.sessionId))}
                  style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
                >
                  <div style={{ fontWeight: 600 }}>{String(h.sessionTitle ?? 'Meeting')}</div>
                  <div style={{ fontSize: 12, color: '#555' }}>
                    {typeof h.startMs === 'number' ? formatClock(h.startMs) : ''} ·{' '}
                    {snippetAround(String(h.text ?? ''), query)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : sessions.length === 0 ? (
        <p style={{ color: '#777' }}>Past meetings will show up here after you record.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {sessions.map((s) => (
            <li key={s.id} style={{ margin: '0 0 10px' }}>
              <button
                onClick={() => void openSession(s.id)}
                style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
              >
                <div style={{ fontWeight: 600 }}>{s.title}</div>
                <div style={{ fontSize: 12, color: '#555' }}>
                  {dateLabel(s.startedAt)} · {durationLabel(s)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SegmentList({ segments, empty }: { segments: TranscriptSegment[]; empty: string }) {
  if (segments.length === 0) {
    return <p style={{ color: '#777' }}>{empty}</p>;
  }
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
      {segments.map((s) => (
        <li key={s.id} style={{ margin: '6px 0' }}>
          <span style={{ color: '#999', fontSize: 11, marginRight: 6 }}>{fmt(s.startMs)}</span>
          {s.speaker && <span style={{ fontWeight: 600, marginRight: 4 }}>{s.speaker}:</span>}
          <span style={s.text === '[transcription failed]' ? { color: 'crimson' } : undefined}>
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

render(<App />, document.getElementById('app')!);
