import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExportActionsAck, TranscriptSegment } from '@scribetab/shared';
import { distinctSpeakers, formatClock, formatUsd, highlightsWithContext, llmEndpoint, originPattern } from '@scribetab/shared';
import type MiniSearch from 'minisearch';
import type { ToSidePanel, Ack } from '@/utils/messages';
import { isHostForbiddenError, isHostMissingError } from '@/utils/nativeSync';
import { downloadExport, type ExportFormat } from '@/utils/exportDownload';
import { getHighlightsForSession } from '@/utils/highlightStore';
import { getSegments } from '@/utils/segmentStore';
import { deleteSession, getSession, listSessions, type StoredSession } from '@/utils/sessionStore';
import { canDeleteSession } from '@/utils/librarySession';
import { getSettings } from '@/utils/settings';
import { nextSelection } from '@/utils/actionExport';
import { humanError } from '@/utils/userError';
import {
  EMPTY_SUMMARY_LIVE,
  applySummaryDelta,
  summaryLivePhase,
  summaryLiveText,
} from '@/utils/summaryLive';
import { createIncrementalSearchCache } from '@/utils/searchCache';
import { snippetAround, type SearchDoc } from '@/utils/search';
import { SegmentList } from './SegmentList';
import { SummaryView } from './SummaryView';

// The cache intentionally lives outside the component so switching tabs or
// remounting the panel does not reread completed transcripts.
const searchCache = createIncrementalSearchCache(getSegments);

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

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function LibraryView() {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<MiniSearch<SearchDoc> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openSegments, setOpenSegments] = useState<TranscriptSegment[]>([]);
  const [openHighlights, setOpenHighlights] = useState<Awaited<ReturnType<typeof getHighlightsForSession>>>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [llmOrigin, setLlmOrigin] = useState<string | null>(null);
  const [summaryLive, setSummaryLive] = useState(EMPTY_SUMMARY_LIVE);
  const [, setTick] = useState(0);
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = openId;

  const reload = async () => {
    const list = await listSessions();
    const docs = await searchCache.sync(list);
    setSessions(list);
    setIndex(searchCache.createIndex());
    return docs;
  };

  const refreshHighlights = async (id: string) => {
    try {
      const highlights = await getHighlightsForSession(id);
      if (openIdRef.current === id) setOpenHighlights(highlights);
    } catch (e) {
      if (openIdRef.current === id) setActionError(humanError(e));
    }
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
      if (msg.type === 'SEGMENTS_ADDED') {
        searchCache.applySegmentsAdded(msg.sessionId, msg.segments);
        setIndex(searchCache.createIndex());
        if (openIdRef.current !== msg.sessionId) return;
        setOpenSegments((prev) => [...prev, ...msg.segments].sort((a, b) => a.startMs - b.startMs));
        return;
      }
      if (msg.type === 'SEGMENTS_UPDATED') {
        searchCache.applySegmentsUpdated(msg.sessionId, msg.segments);
        setIndex(searchCache.createIndex());
        if (openIdRef.current !== msg.sessionId) return;
        setOpenSegments((prev) => {
          const map = new Map(prev.map((s) => [s.id, s]));
          for (const s of msg.segments) map.set(s.id, s);
          return [...map.values()].sort((a, b) => a.startMs - b.startMs);
        });
        return;
      }
      if (msg.type === 'HIGHLIGHT_ADDED') {
        if (openIdRef.current === msg.sessionId) void refreshHighlights(msg.sessionId);
        return;
      }
      void reload();
    };
    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && c.captureState && c.captureState.newValue === 'idle') void reload();
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
    setOpenHighlights([]);
    setSummaryLive(EMPTY_SUMMARY_LIVE);
    const [segments, highlights] = await Promise.all([getSegments(id), getHighlightsForSession(id)]);
    if (openIdRef.current === id) {
      setOpenSegments(segments);
      setOpenHighlights(highlights);
    }
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

  const highlightExtras = highlightsWithContext(openHighlights, openSegments).map(({ highlight, segment }) => ({
    startMs: highlight.startMs,
    ...(highlight.label ? { label: highlight.label } : {}),
    ...(segment?.text ? { text: segment.text } : {}),
  }));

  const exportOne = async (format: ExportFormat) => {
    if (!open) return;
    setBusy(true);
    setActionError(null);
    try {
      await downloadExport(open, openSegments, format, { highlights: highlightExtras });
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshOpen = async (id: string) => {
    const [row, segments] = await Promise.all([getSession(id), getSegments(id)]);
    if (row) {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === id);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = row;
        return next;
      });
    }
    searchCache.applySegments(id, segments);
    setIndex(searchCache.createIndex());
    if (openIdRef.current === id) setOpenSegments(segments);
    await refreshHighlights(id);
  };

  const markOpenPending = () => {
    if (!open) return;
    const startedAt = Date.now();
    setSummaryLive(EMPTY_SUMMARY_LIVE);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === open.id
          ? { ...s, intelligence: 'pending', intelligenceError: null, intelligenceStartedAt: startedAt }
          : s,
      ),
    );
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
        setActionError(isHostMissingError(err) || isHostForbiddenError(err) ? humanError(err) : err);
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
      if (!confirm("Regenerating replaces the action items — export history won't carry over. Continue?")) return;
    }
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

  const deleteOpen = async () => {
    if (!open) return;
    if (!canDeleteSession(open.status)) {
      setActionError('Stop the recording before deleting this meeting.');
      return;
    }
    if (!confirm(`Delete "${open.title}" and its transcript? This cannot be undone.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteSession(open.id);
      setOpenId(null);
      setOpenHighlights([]);
      await reload();
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

  const renameSession = async () => {
    if (!open || busy) return;
    const title = window.prompt('Rename session', open.title);
    if (title === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'RENAME_SESSION',
        sessionId: open.id,
        title: title.trim(),
      })) as Ack;
      if (!res?.ok) {
        setActionError(res?.error ?? humanError('Rename failed'));
        return;
      }
      await reload();
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const renameSpeaker = async (displayName: string) => {
    if (!open || busy) return;
    const from = Object.entries(open.speakerNames ?? {}).find(([, name]) => name === displayName)?.[0] ?? displayName;
    const to = window.prompt(`Rename speaker ${displayName}`, displayName);
    if (to === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'RENAME_SPEAKER',
        sessionId: open.id,
        from,
        to: to.trim(),
      })) as Ack;
      if (!res?.ok) {
        setActionError(res?.error ?? humanError('Speaker rename failed'));
        return;
      }
      await refreshOpen(open.id);
      await reload();
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    const speakers = distinctSpeakers(openSegments);
    const contextualHighlights = highlightsWithContext(openHighlights, openSegments);
    return (
      <section>
        <button class="st-chip" onClick={() => setOpenId(null)} style={{ marginBottom: 8 }}>← Library</button>
        <div class="st-detail-title">
          <h1 style={{ fontSize: 15, margin: '0 0 4px' }}>{open.title}</h1>
          <button type="button" class="st-icon-btn" aria-label="Rename session" disabled={busy} onClick={() => void renameSession()}>✎</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--st-muted)', margin: '0 0 8px' }}>
          {dateLabel(open.startedAt)} · {durationLabel(open)} · {open.platform} · {open.status}
          {open.costUsd !== undefined && <> · {formatUsd(open.costUsd)} est.</>}
        </p>
        {generating && (
          <p class="st-hint st-gen">
            <span class="st-gen-dot" />
            <span>
              {summaryLivePhase(summaryLive) === 'actions' ? 'Extracting action items' : 'Generating summary'}
              {typeof open.intelligenceStartedAt === 'number' ? ` · ${formatElapsed(Math.max(0, Date.now() - open.intelligenceStartedAt))}` : ''}
            </span>
          </p>
        )}
        {open.intelligence === 'pending' && open.intelligenceError && (
          <p data-testid="intelligence-error" class="st-banner st-banner--error">Summary failed: {open.intelligenceError} — use Regenerate summary to retry.</p>
        )}
        {open.intelligence === 'needs-permission' && (
          <p style={{ fontSize: 13 }}>
            <button class="st-btn" disabled={busy} onClick={() => void grantLlmAndRegenerate()}>Grant permission</button>{' '}
            to generate a summary for this meeting.
          </p>
        )}
        {generating && summaryLiveText(summaryLive) && <article class="st-summary">{summaryLiveText(summaryLive)}</article>}
        {!generating && open.summary ? (
          <SummaryView key={open.id} sessionId={open.id} summary={open.summary} exports={open.actionExports ?? {}} busy={busy} onExport={exportSelected} />
        ) : !generating && open.summaryMarkdown ? (
          <article class="st-summary">{open.summaryMarkdown}</article>
        ) : null}
        {speakers.length > 0 && (
          <section class="st-detail-card" aria-label="Speakers">
            <h2>Speakers</h2>
            <div class="st-speakers">
              {speakers.map((speaker) => (
                <span class="st-speaker" key={speaker}>
                  {speaker}
                  <button type="button" class="st-icon-btn" aria-label={`Rename speaker ${speaker}`} disabled={busy} onClick={() => void renameSpeaker(speaker)}>✎</button>
                </span>
              ))}
            </div>
          </section>
        )}
        {contextualHighlights.length > 0 && (
          <section class="st-detail-card" aria-label="Highlights">
            <h2>Highlights</h2>
            <ol class="st-highlights">
              {contextualHighlights.map(({ highlight, segment }) => (
                <li key={highlight.id}>
                  <span class="st-highlight-time">{formatClock(highlight.startMs)}</span>
                  <span class="st-highlight-text">
                    {highlight.label && <strong>{highlight.label}</strong>}
                    {segment?.text && <span>{segment.text}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['md', 'json', 'srt', 'vtt'] as const).map((f) => (
            <button class="st-chip" key={f} disabled={busy} onClick={() => void exportOne(f)}>Export .{f}</button>
          ))}
          <button class="st-chip" disabled={busy} onClick={() => void exportOne('notebooklm')}>Export for NotebookLM</button>
          <button class="st-chip" disabled={busy} onClick={() => void regenerateSummary()}>Regenerate summary</button>
          <button data-testid="delete-session" class="st-chip st-chip--danger" disabled={busy} onClick={() => void deleteOpen()}>Delete</button>
        </div>
        {actionError && <p data-testid="library-error" class="st-banner st-banner--error">{actionError}</p>}
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
          <p data-testid="library-empty-search" class="st-empty">No matches for that search.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hits.map((h) => (
              <li key={h.id}>
                <button class="st-session" onClick={() => void openSession(String(h.sessionId))}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div class="st-title">{String(h.sessionTitle ?? 'Meeting')}</div>
                    <div class="st-meta">{typeof h.startMs === 'number' ? formatClock(h.startMs) : ''} · {snippetAround(String(h.text ?? ''), query)}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : sessions.length === 0 ? (
        <p data-testid="library-empty" class="st-empty">No meetings yet. Record a tab from the popup — past sessions will show up here.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map((s) => (
            <li key={s.id}>
              <button class="st-session" onClick={() => void openSession(s.id)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div class="st-title">{s.title}</div>
                  <div class="st-meta">{dateLabel(s.startedAt)} · {durationLabel(s)}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
