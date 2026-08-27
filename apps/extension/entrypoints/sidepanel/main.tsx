import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TranscriptSegment } from '@scribetab/shared';
import { formatClock, formatUsd, llmEndpoint, originPattern } from '@scribetab/shared';
import type MiniSearch from 'minisearch';
import { ConsentBanner } from '@/components/ConsentBanner';
import type { Ack, CaptureState, ToSidePanel, TranscriptionIssue } from '@/utils/messages';
import type { NativeHostStatus } from '@/utils/nativeSync';
import { downloadExport, type ExportFormat } from '@/utils/exportDownload';
import { getAllSegments, getSegments } from '@/utils/segmentStore';
import { createSegmentIndex, snippetAround, type SearchDoc } from '@/utils/search';
import { getSession, listSessions, type StoredSession } from '@/utils/sessionStore';
import { getSettings } from '@/utils/settings';
import { humanError } from '@/utils/userError';
import { addPending, clearPending, resolveBelow, resolvePending, type PendingChunk } from '@/utils/pendingChunks';
import {
  EMPTY_SUMMARY_LIVE,
  applySummaryDelta,
  summaryLivePhase,
  summaryLiveText,
} from '@/utils/summaryLive';
import '@/assets/theme.css';

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
    <main data-testid="sidepanel-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header class="st-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <div class="st-brand">
          <img src="/icon-48.png" alt="" />
          <span class="st-wordmark">
            scribe<b>Tab</b>
          </span>
        </div>
        <nav class="st-seg">
          {(['live', 'library'] as const).map((t) => (
            <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      <div class="st-body" style={{ flexGrow: 1 }}>
        {quotaWarning && (
          <p class="st-banner st-banner--warn">
            Storage is over 80% full. Oldest meeting audio is being removed; transcripts are kept.
          </p>
        )}
        {tab === 'live' ? <LiveView /> : <LibraryView />}
      </div>
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
  const [pending, setPending] = useState<PendingChunk[]>([]);
  const [transcribedCount, setTranscribedCount] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
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
        const sid = (v.currentSessionId as string) ?? null;
        setSessionId(sid);
        if (sid) setSegments(await getSegments(sid));
      });

    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState) {
        const next = (c.captureState.newValue as CaptureState) ?? 'idle';
        setState(next);
        if (next === 'idle') setPending(clearPending());
      }
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
      if ('transcribedCount' in c) {
        const count = typeof c.transcribedCount.newValue === 'number' ? c.transcribedCount.newValue : 0;
        setTranscribedCount(count);
        setPending((prev) => resolveBelow(prev, count));
      }
      if ('chunkCount' in c) {
        setChunkCount(typeof c.chunkCount.newValue === 'number' ? c.chunkCount.newValue : 0);
      }
      if (c.currentSessionId) {
        const sid = (c.currentSessionId.newValue as string) ?? null;
        setSessionId(sid);
        setSegments([]);
        setPending(clearPending());
        if (sid) void getSegments(sid).then(setSegments);
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
        setSegments((prev) =>
          [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs),
        );
        const resolvedIndex = msg.chunkIndex;
        if (typeof resolvedIndex === 'number') {
          setPending((prev) => resolvePending(prev, resolvedIndex));
        }
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
  }, [segments.length, pending.length]);

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

      <ConsentBanner recording={state === 'recording' || state === 'starting' || state === 'stopping'} />
      {notice && (
        <p class="st-banner st-banner--warn">{notice}</p>
      )}
      {!configured && issue === 'missing-permission' && (
        <p data-testid="live-permission" class="st-banner st-banner--warn">
          Host permission for the transcription provider is missing — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Open settings
          </a>
        </p>
      )}
      {!configured && issue !== 'missing-permission' && (
        <p data-testid="live-unconfigured" class="st-banner st-banner--warn">
          No transcription provider configured — recording audio only.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); }}>
            Open settings
          </a>
        </p>
      )}
      {lastTranscriptionError && (
        <p data-testid="live-transcription-error" class="st-banner st-banner--error">
          {lastTranscriptionError}
        </p>
      )}

      {state === 'idle' && segments.length === 0 && pending.length === 0 ? (
        <p data-testid="live-empty" class="st-empty">
          No live session. Start recording from the popup or press Alt+Shift+R.
        </p>
      ) : (
        <SegmentList segments={segments} pending={pending} empty="Segments appear here as chunks are transcribed." />
      )}
      {state === 'recording' && (
        <p class="st-hint st-livestatus">
          {transcribedCount < chunkCount
            ? `Transcribing chunk ${Math.min(transcribedCount + 1, chunkCount)} of ${chunkCount}`
            : 'Listening…'}
        </p>
      )}
      {state === 'stopping' && transcribedCount < chunkCount && (
        <p class="st-hint st-livestatus">
          Finishing transcription… {transcribedCount} / {chunkCount}
        </p>
      )}
      <div ref={endRef} />

      <footer style={{ marginTop: 16, borderTop: '1px solid var(--st-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        <button
          class="st-btn st-btn--quiet"
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
          <p class="st-banner st-banner--warn">
            Native host not installed. Run <code>node apps/native-host/dist/host.bin.js install</code>{' '}
            (or <code>npx scribetab-host install</code> once published) then try Sync all.
          </p>
        )}
        {hostStatus.state === 'error' && hostStatus.message && (
          <p data-testid="sync-error" class="st-banner st-banner--error">
            {hostStatus.message}
          </p>
        )}
        {hostStatus.state === 'ok' && (
          <p class="st-ok-text">Synced to ~/ScribeTab/meetings</p>
        )}
        {hostStatus.state === 'ok' && hostStatus.warning && (
          <p class="st-banner st-banner--warn">
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
  const [summaryLive, setSummaryLive] = useState(EMPTY_SUMMARY_LIVE);
  const [, setTick] = useState(0);
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
      if (msg.type === 'SUMMARY_DELTA') {
        if (openIdRef.current !== msg.sessionId) return;
        setSummaryLive((prev) => applySummaryDelta(prev, msg));
        return;
      }
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
    setSummaryLive(EMPTY_SUMMARY_LIVE);
    const segs = await getSegments(id);
    if (openIdRef.current === id) setOpenSegments(segs);
  };

  const hits = query.trim() && index ? index.search(query.trim()) : [];
  const open = sessions.find((s) => s.id === openId) ?? null;
  const generating = Boolean(open && open.intelligence === 'pending' && !open.intelligenceError);

  useEffect(() => {
    if (!openId || !generating) return;
    const t = window.setInterval(() => {
      setTick((n) => n + 1);
      const id = openIdRef.current;
      if (!id) return;
      void getSession(id).then((row) => {
        if (!row || openIdRef.current !== id) return;
        setSessions((prev) => {
          const i = prev.findIndex((s) => s.id === id);
          if (i < 0) return prev;
          const next = prev.slice();
          next[i] = row;
          return next;
        });
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [openId, generating]);

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

  const markOpenPending = () => {
    if (!open) return;
    const startedAt = Date.now();
    setSummaryLive(EMPTY_SUMMARY_LIVE);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === open.id
          ? {
              ...s,
              intelligence: 'pending',
              intelligenceError: null,
              intelligenceStartedAt: startedAt,
            }
          : s,
      ),
    );
  };

  const regenerateSummary = async () => {
    if (!open) return;
    setBusy(true);
    setActionError(null);
    markOpenPending();
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
      markOpenPending();
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
        <button class="st-chip" onClick={() => setOpenId(null)} style={{ marginBottom: 8 }}>
          ← Library
        </button>
        <h1 style={{ fontSize: 15, margin: '0 0 4px' }}>{open.title}</h1>
        <p style={{ fontSize: 12, color: 'var(--st-muted)', margin: '0 0 8px' }}>
          {dateLabel(open.startedAt)} · {durationLabel(open)} · {open.platform} · {open.status}
          {open.costUsd !== undefined && (
            <> · {formatUsd(open.costUsd)} est.</>
          )}
        </p>
        {generating && (
          <p class="st-hint st-gen">
            <span class="st-gen-dot" />
            <span>
              {summaryLivePhase(summaryLive) === 'actions'
                ? 'Extracting action items'
                : 'Generating summary'}
              {typeof open.intelligenceStartedAt === 'number'
                ? ` · ${fmt(Math.max(0, Date.now() - open.intelligenceStartedAt))}`
                : ''}
            </span>
          </p>
        )}
        {open.intelligence === 'pending' && open.intelligenceError && (
          <p data-testid="intelligence-error" class="st-banner st-banner--error">
            Summary failed: {open.intelligenceError} — use Regenerate summary to retry.
          </p>
        )}
        {open.intelligence === 'needs-permission' && (
          <p style={{ fontSize: 13 }}>
            <button class="st-btn" disabled={busy} onClick={() => void grantLlmAndRegenerate()}>
              Grant permission
            </button>{' '}
            to generate a summary for this meeting.
          </p>
        )}
        {generating && summaryLiveText(summaryLive) && (
          <article class="st-summary">{summaryLiveText(summaryLive)}</article>
        )}
        {!generating && open.summaryMarkdown && (
          <article class="st-summary">{open.summaryMarkdown}</article>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['md', 'json', 'srt', 'vtt'] as const).map((f) => (
            <button class="st-chip" key={f} disabled={busy} onClick={() => void exportOne(f)}>
              Export .{f}
            </button>
          ))}
          <button class="st-chip" disabled={busy} onClick={() => void exportOne('notebooklm')}>
            Export for NotebookLM
          </button>
          <button class="st-chip" disabled={busy} onClick={() => void regenerateSummary()}>
            Regenerate summary
          </button>
        </div>
        {actionError && (
          <p data-testid="library-error" class="st-banner st-banner--error">
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
        class="st-input"
        style={{ maxWidth: 'none', marginBottom: 10 }}
      />
      {query.trim() ? (
        hits.length === 0 ? (
          <p data-testid="library-empty-search" class="st-empty">
            No matches for that search.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hits.map((h) => (
              <li key={h.id}>
                <button class="st-session" onClick={() => void openSession(String(h.sessionId))}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div class="st-title">{String(h.sessionTitle ?? 'Meeting')}</div>
                  <div class="st-meta">
                    {typeof h.startMs === 'number' ? formatClock(h.startMs) : ''} ·{' '}
                    {snippetAround(String(h.text ?? ''), query)}
                  </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : sessions.length === 0 ? (
        <p data-testid="library-empty" class="st-empty">
          No meetings yet. Record a tab from the popup — past sessions will show up here.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map((s) => (
            <li key={s.id}>
              <button class="st-session" onClick={() => void openSession(s.id)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div class="st-title">{s.title}</div>
                  <div class="st-meta">
                    {dateLabel(s.startedAt)} · {durationLabel(s)}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SegmentList({
  segments,
  pending,
  empty,
}: {
  segments: TranscriptSegment[];
  pending?: readonly PendingChunk[];
  empty: string;
}) {
  const pendingRows = pending ?? [];
  if (segments.length === 0 && pendingRows.length === 0) {
    return <p class="st-empty">{empty}</p>;
  }
  return (
    <ol class="st-segments">
      {segments.map((s) => (
        <li key={s.id}>
          <span class="st-time">{fmt(s.startMs)}</span>
          <span class="st-text" style={s.text === '[transcription failed]' ? { color: 'var(--st-danger)' } : undefined}>
            {s.speaker && <strong>{s.speaker}: </strong>}
            {s.text}
          </span>
        </li>
      ))}
      {pendingRows.map((p) => (
        <li key={`pending-${p.chunkIndex}`} class="st-segment--pending">
          <span class="st-time">{fmt(p.startMs)}</span>
          <span class="st-text">
            <span class="st-shimmer" />
            Transcribing…
          </span>
        </li>
      ))}
    </ol>
  );
}

render(<App />, document.getElementById('app')!);
