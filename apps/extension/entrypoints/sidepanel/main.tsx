import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExportActionsAck, SessionSummary, TranscriptSegment } from '@scribetab/shared';
import { actionItemLine, formatClock, formatUsd, llmEndpoint, originPattern } from '@scribetab/shared';
import type MiniSearch from 'minisearch';
import { ConsentBanner } from '@/components/ConsentBanner';
import type { Ack, CaptureState, ToSidePanel, TranscriptionIssue } from '@/utils/messages';
import { isHostForbiddenError, isHostMissingError, type NativeHostStatus } from '@/utils/nativeSync';
import { downloadExport, type ExportFormat } from '@/utils/exportDownload';
import { getAllSegments, getSegments } from '@/utils/segmentStore';
import { createSegmentIndex, snippetAround, type SearchDoc } from '@/utils/search';
import { getSession, listSessions, type StoredSession } from '@/utils/sessionStore';
import { getSettings } from '@/utils/settings';
import { nextSelection } from '@/utils/actionExport';
import { humanError } from '@/utils/userError';

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function durationLabel(session: StoredSession): string {
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
    <main data-testid="sidepanel-root" style={{ padding: 12, fontFamily: 'system-ui', fontSize: 14 }}>
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
  const [issue, setIssue] = useState<TranscriptionIssue>(null);
  const [lastTranscriptionError, setLastTranscriptionError] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<string>('off');
  const [hostStatus, setHostStatus] = useState<NativeHostStatus>({ state: 'idle' });
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
    void chrome.storage.local
      .get(['currentSessionId', 'captureState', 'transcriptionConfigured', 'transcriptionIssue', 'lastTranscriptionError', 'micStatus', 'nativeHostStatus', 'captureNotice'])
      .then(async (v) => {
        setState((v.captureState as CaptureState) ?? 'idle');
        setConfigured((v.transcriptionConfigured as boolean) ?? true);
        setIssue((v.transcriptionIssue as TranscriptionIssue) ?? null);
        setLastTranscriptionError(
          typeof v.lastTranscriptionError === 'string' && v.lastTranscriptionError
            ? v.lastTranscriptionError
            : null,
        );
        setMicStatus((v.micStatus as string) ?? 'off');
        if (v.nativeHostStatus) setHostStatus(v.nativeHostStatus as NativeHostStatus);
        setNotice(typeof v.captureNotice === 'string' && v.captureNotice ? v.captureNotice : null);
        const sid = (v.currentSessionId as string) ?? null;
        setSessionId(sid);
        if (sid) setSegments(await getSegments(sid));
      });

    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) setState((c.captureState.newValue as CaptureState) ?? 'idle');
      if (c.transcriptionConfigured) setConfigured(Boolean(c.transcriptionConfigured.newValue));
      if ('transcriptionIssue' in c) {
        setIssue((c.transcriptionIssue.newValue as TranscriptionIssue) ?? null);
      }
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
      if (msg?.target !== 'sidepanel') return;
      if (sessionRef.current && msg.sessionId !== sessionRef.current) return;
      if (msg.type === 'SEGMENTS_ADDED') {
        setSegments((prev) =>
          [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs),
        );
      } else if (msg.type === 'SEGMENTS_UPDATED') {
        setSegments((prev) => {
          const map = new Map(prev.map((s) => [s.id, s]));
          for (const s of msg.segments) map.set(s.id, s);
          return [...map.values()].sort((a, b) => a.startMs - b.startMs);
        });
      }
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

      <ConsentBanner recording={state === 'recording' || state === 'starting' || state === 'stopping'} />
      {notice && (
        <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 13 }}>{notice}</p>
      )}
      {!configured && issue === 'missing-permission' && (
        <p data-testid="live-permission" style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 13 }}>
          Host permission for the transcription provider is missing — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Open settings
          </a>
        </p>
      )}
      {!configured && issue !== 'missing-permission' && (
        <p data-testid="live-unconfigured" style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 13 }}>
          No transcription provider configured — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Open settings
          </a>
        </p>
      )}
      {lastTranscriptionError && (
        <p data-testid="live-transcription-error" style={{ color: 'crimson', fontSize: 13 }}>
          {lastTranscriptionError}
        </p>
      )}

      {state === 'idle' && segments.length === 0 ? (
        <p data-testid="live-empty" style={{ color: '#777' }}>
          No live session. Start recording from the popup or press Alt+Shift+R.
        </p>
      ) : (
        <SegmentList segments={segments} empty="Segments appear here as chunks are transcribed." />
      )}
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
                  setHostStatus({
                    state: 'error',
                    message: res?.error ?? humanError('Sync failed'),
                  });
                } else {
                  setHostStatus({ state: 'ok', warning: res.warning });
                }
              })
              .finally(() => setSyncing(false));
          }}
        >
          {syncing ? 'Syncing…' : 'Sync all'}
        </button>
        {hostStatus.state === 'missing' && (
          <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 12 }}>
            Native host not installed. Run <code>node apps/native-host/dist/host.bin.js install</code>{' '}
            (or <code>npx scribetab-host install</code> once published) then try Sync all.
          </p>
        )}
        {hostStatus.state === 'error' && hostStatus.message && (
          <p data-testid="sync-error" style={{ color: 'crimson', fontSize: 12 }}>
            {hostStatus.message}
          </p>
        )}
        {hostStatus.state === 'ok' && (
          <p style={{ color: 'green', fontSize: 12 }}>Synced to ~/ScribeTab/meetings</p>
        )}
        {hostStatus.state === 'ok' && hostStatus.warning && (
          <p style={{ color: '#8a6d00', background: '#fff8e1', padding: 8, fontSize: 12 }}>
            Integrations: {hostStatus.warning}
          </p>
        )}
      </footer>
    </section>
  );
}

function LibraryView() {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<MiniSearch<SearchDoc> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openSegments, setOpenSegments] = useState<TranscriptSegment[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [llmOrigin, setLlmOrigin] = useState<string | null>(null);
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
    void getSettings().then((s) => {
      if (s.llmProviderId === '') {
        setLlmOrigin(null);
        return;
      }
      try {
        setLlmOrigin(
          originPattern(
            llmEndpoint(
              s.llmProviderId,
              s.llmProviderId === 'custom' ? s.llmBaseUrl.trim() || undefined : undefined,
            ),
          ),
        );
      } catch {
        setLlmOrigin(null);
      }
    });

    const onMessage = (raw: unknown) => {
      const msg = raw as ToSidePanel;
      if (msg?.target !== 'sidepanel') return;
      void reload();
      if (openIdRef.current !== msg.sessionId) return;
      if (msg.type === 'SEGMENTS_ADDED') {
        setOpenSegments((prev) =>
          [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs),
        );
      } else if (msg.type === 'SEGMENTS_UPDATED') {
        setOpenSegments((prev) => {
          const map = new Map(prev.map((s) => [s.id, s]));
          for (const s of msg.segments) map.set(s.id, s);
          return [...map.values()].sort((a, b) => a.startMs - b.startMs);
        });
      }
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
    setActionError(null);
    try {
      await downloadExport(open, openSegments, format);
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshOpen = async (id: string) => {
    const row = await getSession(id);
    if (row) {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === id);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = row;
        return next;
      });
    }
    const segs = await getSegments(id);
    if (openIdRef.current === id) setOpenSegments(segs);
  };

  const exportSelected = async (itemIds: string[]): Promise<ExportActionsAck | undefined> => {
    if (!open) return undefined;
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'EXPORT_ACTIONS',
        sessionId: open.id,
        itemIds,
      })) as ExportActionsAck;
      if (!res?.ok && (!res?.results || res.results.length === 0)) {
        const err = res?.error ?? 'Unknown error';
        setActionError(
          isHostMissingError(err) || isHostForbiddenError(err) ? humanError(err) : err,
        );
      }
      await refreshOpen(open.id);
      return res;
    } catch (e) {
      setActionError(humanError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const regenerateSummary = async () => {
    if (!open) return;
    if (open.summary && open.actionExports && Object.keys(open.actionExports).length > 0) {
      if (
        !confirm(
          "Regenerating replaces the action items — export history won't carry over. Continue?",
        )
      ) {
        return;
      }
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'REGENERATE_SUMMARY',
        sessionId: open.id,
      } satisfies { target: 'background'; type: 'REGENERATE_SUMMARY'; sessionId: string })) as Ack;
      if (!res?.ok) setActionError(res?.error ?? humanError('Unknown error'));
      await refreshOpen(open.id);
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const grantLlmAndRegenerate = async () => {
    if (!open) return;
    setBusy(true);
    setActionError(null);
    try {
      if (!llmOrigin) {
        setActionError('Configure an LLM provider in settings to generate summaries.');
        return;
      }
      const granted = await chrome.permissions.request({ origins: [llmOrigin] });
      if (!granted) {
        setActionError('Permission was declined, so that provider cannot be reached.');
        return;
      }
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'REGENERATE_SUMMARY',
        sessionId: open.id,
      })) as Ack;
      if (!res?.ok) setActionError(res?.error ?? humanError('Unknown error'));
      await refreshOpen(open.id);
    } catch (e) {
      setActionError(humanError(e));
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
          {open.costUsd !== undefined && (
            <> · {formatUsd(open.costUsd)} est.</>
          )}
        </p>
        {open.intelligence === 'pending' && (
          <p style={{ fontSize: 13, color: '#555' }}>Generating summary…</p>
        )}
        {open.intelligence === 'needs-permission' && (
          <p style={{ fontSize: 13 }}>
            <button disabled={busy} onClick={() => void grantLlmAndRegenerate()}>
              Grant permission
            </button>{' '}
            to generate a summary for this meeting.
          </p>
        )}
        {open.summary ? (
          <SummaryView
            key={open.id}
            sessionId={open.id}
            summary={open.summary}
            exports={open.actionExports ?? {}}
            busy={busy}
            onExport={exportSelected}
          />
        ) : open.summaryMarkdown ? (
          <article style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 8, fontSize: 13, marginBottom: 12 }}>
            {open.summaryMarkdown}
          </article>
        ) : null}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['md', 'json', 'srt', 'vtt'] as const).map((f) => (
            <button key={f} disabled={busy} onClick={() => void exportOne(f)}>
              Export .{f}
            </button>
          ))}
          <button disabled={busy} onClick={() => void exportOne('notebooklm')}>
            Export for NotebookLM
          </button>
          <button disabled={busy} onClick={() => void regenerateSummary()}>
            Regenerate summary
          </button>
        </div>
        {actionError && (
          <p data-testid="library-error" style={{ color: 'crimson', fontSize: 12 }}>
            {actionError}
          </p>
        )}
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
          <p data-testid="library-empty-search" style={{ color: '#777' }}>
            No matches for that search.
          </p>
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
        <p data-testid="library-empty" style={{ color: '#777' }}>
          No meetings yet. Record a tab from the popup — past sessions will show up here.
        </p>
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

function SummaryView({
  sessionId,
  summary,
  exports,
  busy,
  onExport,
}: {
  sessionId: string;
  summary: SessionSummary;
  exports: NonNullable<StoredSession['actionExports']>;
  busy: boolean;
  onExport: (itemIds: string[]) => Promise<ExportActionsAck | undefined>;
}) {
  const initialSel = () =>
    new Set(summary.actionItems.filter((a) => !exports[a.id]).map((a) => a.id));
  const [sel, setSel] = useState<Set<string>>(initialSel);
  const [lastResults, setLastResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [retryCount, setRetryCount] = useState<number | null>(null);

  useEffect(() => {
    setSel(new Set(summary.actionItems.filter((a) => !exports[a.id]).map((a) => a.id)));
    setLastResults({});
    setRetryCount(null);
  }, [sessionId, summary.generatedAt]);

  const sec = { fontSize: 13, margin: '0 0 4px', fontWeight: 600 };
  return (
    <div style={{ background: '#f6f6f6', padding: 8, fontSize: 13, marginBottom: 12 }}>
      {summary.degraded && (
        <p style={{ color: '#a60', fontSize: 12, margin: '0 0 6px' }}>
          Structured extraction failed — showing plain summary.
        </p>
      )}
      {summary.narrative && <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{summary.narrative}</p>}
      {summary.actionItems.length > 0 && (
        <>
          <h2 style={sec}>Action items</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
            {summary.actionItems.map((a) => {
              const exported = Boolean(exports[a.id]);
              const fail = lastResults[a.id] && !lastResults[a.id]!.ok ? lastResults[a.id]!.error : undefined;
              return (
                <li key={a.id} style={{ marginBottom: 4 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <input
                      type="checkbox"
                      disabled={exported || busy}
                      checked={exported ? false : sel.has(a.id)}
                      onChange={(e) => {
                        const on = (e.currentTarget as HTMLInputElement).checked;
                        setRetryCount(null);
                        setSel((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(a.id);
                          else next.delete(a.id);
                          return next;
                        });
                      }}
                    />
                    <span>{actionItemLine(a)}</span>
                    {exported && (
                      <span
                        style={{
                          fontSize: 10,
                          color: '#2a7',
                          border: '1px solid #2a7',
                          borderRadius: 3,
                          padding: '0 3px',
                        }}
                      >
                        exported
                      </span>
                    )}
                  </label>
                  {fail && (
                    <p style={{ color: 'crimson', fontSize: 11, margin: '2px 0 0 22px' }}>{fail}</p>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            disabled={busy || sel.size === 0}
            onClick={() => {
              void (async () => {
                const ack = await onExport([...sel]);
                if (!ack) return;
                const map: Record<string, { ok: boolean; error?: string }> = {};
                for (const r of ack.results) map[r.id] = r;
                setLastResults(map);
                const next = nextSelection(sel, ack);
                setSel(next.sel);
                setRetryCount(next.retryCount);
              })();
            }}
          >
            {retryCount != null ? `Retry ${retryCount} failed` : `Export ${sel.size} to Notion`}
          </button>
        </>
      )}
      {summary.decisions.length > 0 && (
        <>
          <h2 style={sec}>Decisions</h2>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {summary.decisions.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </>
      )}
      {summary.usefulInfo.length > 0 && (
        <>
          <h2 style={sec}>Useful info</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {summary.usefulInfo.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </>
      )}
    </div>
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
          {s.speaker && <strong style={{ marginRight: 4 }}>{s.speaker}:</strong>}
          <span style={s.text === '[transcription failed]' ? { color: 'crimson' } : undefined}>
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

render(<App />, document.getElementById('app')!);
