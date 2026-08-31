import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExportActionsAck, HighlightKind, SummaryTemplate, TranscriptExportOptions, TranscriptSegment } from '@scribetab/shared';
import { DEFAULT_TRANSCRIPT_EXPORT_OPTIONS, distinctSpeakers, formatClock, formatUsd, HIGHLIGHT_KINDS, highlightKindEmoji, highlightsWithContext, llmEndpoint, originPattern } from '@scribetab/shared';
import type MiniSearch from 'minisearch';
import type {
  Ack,
  ImportTranscriptAck,
  LibraryAskAck,
  LibraryAskSource,
  ToBackground,
  ToSidePanel,
} from '@/utils/messages';
import { isHostForbiddenError, isHostMissingError } from '@/utils/nativeSync';
import { clipboardWriter, copyMarkdownExport, downloadExport, type ExportFormat } from '@/utils/exportDownload';
import { getHighlightsForSession } from '@/utils/highlightStore';
import { getSegments } from '@/utils/segmentStore';
import { deleteSession, getSession, listSessions, type StoredSession } from '@/utils/sessionStore';
import { canDeleteSession } from '@/utils/librarySession';
import {
  DEFAULT_TEMPLATE_LABEL,
  SETTINGS_STORAGE_KEY,
  getSettings,
  normalizeSettings,
  summaryTemplateChoices,
  type Settings,
} from '@/utils/settings';
import { nextSelection } from '@/utils/actionExport';
import { applyStoredSpeakerNames, speakerMergeTarget } from '@/utils/speakerRename';
import { humanError } from '@/utils/userError';
import {
  EMPTY_SUMMARY_LIVE,
  applySummaryDelta,
  summaryLivePhase,
  summaryLiveText,
} from '@/utils/summaryLive';
import { createIncrementalSearchCache } from '@/utils/searchCache';
import { loadOpenSessionData } from '@/utils/openSessionData';
import { canApplySessionRead, type SessionReadToken } from '@/utils/sessionReadGuard';
import { mergeSegments } from '@/utils/segmentMerge';
import { snippetAround, type SearchDoc } from '@/utils/search';
import { LatestReloadCoordinator } from '@/utils/latestReload';
import {
  PLAYBACK_RATES,
  SEEK_STEP_MS,
  assembleSessionAudio,
  playbackKeyAction,
  playingSegmentIndex,
  revokeSessionAudio,
  type SessionAudioSource,
} from '@/utils/playback';
import { ChatView } from './ChatView';
import { SummaryView } from './SummaryView';

// The cache intentionally lives outside the component so switching tabs or
// remounting the panel does not reread completed transcripts.
const searchCache = createIncrementalSearchCache(getSegments);
const reloadCoordinator = new LatestReloadCoordinator();

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

function sessionCardMeta(session: StoredSession): string {
  const parts = [dateLabel(session.startedAt), durationLabel(session)];
  const provider = session.providerId?.trim();
  const model = session.model?.trim();
  if (provider && model) parts.push(`${provider} / ${model}`);
  else if (provider || model) parts.push(provider || model || '');
  if (session.costUsd !== undefined) parts.push(`${formatUsd(session.costUsd)} est.`);
  return parts.filter(Boolean).join(' · ');
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Markdown export / clipboard transcript options, in checkbox row order.
const EXPORT_OPTIONS: ReadonlyArray<{ key: keyof TranscriptExportOptions; label: string }> = [
  { key: 'timestamps', label: 'Timestamps' },
  { key: 'speakers', label: 'Speakers' },
  { key: 'combineSameSpeaker', label: 'Combine same speaker' },
];

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
  const [summaryTemplates, setSummaryTemplates] = useState<SummaryTemplate[]>([]);
  const [regenerateTemplateId, setRegenerateTemplateId] = useState('');
  const [summaryLive, setSummaryLive] = useState(EMPTY_SUMMARY_LIVE);
  const [audioSource, setAudioSource] = useState<(SessionAudioSource & { sessionId: string }) | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioRevision, setAudioRevision] = useState(0);
  const [exportOptions, setExportOptions] = useState<Required<TranscriptExportOptions>>({
    ...DEFAULT_TRANSCRIPT_EXPORT_OPTIONS,
  });
  const [copied, setCopied] = useState(false);
  const [detailPane, setDetailPane] = useState<'transcript' | 'ask'>('transcript');
  const [highlightFilter, setHighlightFilter] = useState<HighlightKind | 'all'>('all');
  const [askQuery, setAskQuery] = useState('');
  const [askPending, setAskPending] = useState(false);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askSources, setAskSources] = useState<LibraryAskSource[]>([]);
  const [askError, setAskError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const openIdRef = useRef<string | null>(null);
  const openReadVersionRef = useRef(0);
  const openHighlightVersionRef = useRef(0);
  openIdRef.current = openId;

  const reload = async () => {
    const generation = reloadCoordinator.begin();
    const list = await listSessions();
    if (!reloadCoordinator.isCurrent(generation)) return undefined;
    const docs = await searchCache.sync(list.filter((session) => session.archivedAt === undefined));
    if (!reloadCoordinator.isCurrent(generation)) return undefined;
    setSessions(list);
    setIndex(searchCache.createIndex());
    return docs;
  };

  const refreshHighlights = async (id: string, version: number) => {
    const token: SessionReadToken = { sessionId: id, version };
    try {
      const highlights = await getHighlightsForSession(id);
      const current = openHighlightVersionRef.current;
      if (canApplySessionRead(token, openIdRef.current, current)) setOpenHighlights(highlights);
    } catch (e) {
      const current = openHighlightVersionRef.current;
      if (canApplySessionRead(token, openIdRef.current, current)) setActionError(humanError(e));
    }
  };

  useEffect(() => {
    void reload();
    const applySettings = (s: Settings) => {
      setSummaryTemplates(summaryTemplateChoices(s));
      setRegenerateTemplateId(s.activeTemplateId);
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
    };
    void getSettings().then(applySettings);

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
        setOpenSegments((prev) => mergeSegments(prev, msg.segments));
        return;
      }
      if (msg.type === 'SEGMENTS_UPDATED') {
        searchCache.applySegmentsUpdated(msg.sessionId, msg.segments);
        setIndex(searchCache.createIndex());
        if (openIdRef.current !== msg.sessionId) return;
        setOpenSegments((prev) => mergeSegments(prev, msg.segments));
        return;
      }
      if (msg.type === 'HIGHLIGHT_ADDED') {
        if (openIdRef.current === msg.sessionId) {
          const version = ++openHighlightVersionRef.current;
          void refreshHighlights(msg.sessionId, version);
        }
        return;
      }
      void reload();
    };
    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (c.captureState?.newValue === 'idle') {
        setAudioRevision((revision) => revision + 1);
        void reload();
      }
      if (c.quotaWarning) setAudioRevision((revision) => revision + 1);
      const settingsChange = c[SETTINGS_STORAGE_KEY];
      if (settingsChange) {
        applySettings(
          normalizeSettings(settingsChange.newValue as Partial<Settings> | undefined),
        );
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  const askLibrary = async () => {
    const q = askQuery.trim();
    if (!q || askPending) return;
    setAskError(null);
    setAskAnswer(null);
    setAskSources([]);
    setAskPending(true);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'LIBRARY_ASK',
        question: q,
      } satisfies ToBackground)) as LibraryAskAck;
      if (res?.ok && typeof res.answer === 'string') {
        setAskAnswer(res.answer);
        setAskSources(res.sources ?? []);
        setAskQuery('');
      } else if (res?.error === 'needs-permission') {
        setAskError('Grant the LLM provider host permission (see the summary section) to ask across meetings.');
      } else {
        setAskError(res?.error ?? humanError('Ask failed'));
      }
    } catch (e) {
      setAskError(humanError(e));
    } finally {
      setAskPending(false);
    }
  };

  const openSession = async (id: string) => {
    openIdRef.current = id;
    const version = ++openReadVersionRef.current;
    const highlightVersion = ++openHighlightVersionRef.current;
    const token: SessionReadToken = { sessionId: id, version };
    const highlightToken: SessionReadToken = { sessionId: id, version: highlightVersion };
    setOpenId(id);
    setOpenSegments([]);
    setOpenHighlights([]);
    setHighlightFilter('all');
    setSummaryLive(EMPTY_SUMMARY_LIVE);
    setCopied(false);
    setDetailPane('transcript');
    const data = await loadOpenSessionData(id);
    const currentRead = openReadVersionRef.current;
    const currentHighlights = openHighlightVersionRef.current;
    const canApplyTranscript = canApplySessionRead(token, openIdRef.current, currentRead);
    const canApplyHighlights = canApplySessionRead(highlightToken, openIdRef.current, currentHighlights);
    if (canApplyTranscript && !data.segmentsError) {
      setOpenSegments((prev) => mergeSegments(data.segments, prev));
    }
    if (canApplyHighlights && !data.highlightsError) setOpenHighlights(data.highlights);
    if (canApplyTranscript && data.segmentsError) setActionError(humanError(data.segmentsError));
    if (canApplyHighlights && data.highlightsError) setActionError(humanError(data.highlightsError));
  };

  const importTranscript = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const content = await file.text();
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'IMPORT_TRANSCRIPT',
        name: file.name,
        content,
      } satisfies ToBackground)) as ImportTranscriptAck;
      if (!res?.ok) {
        setActionError(res?.error ?? humanError('Transcript import failed'));
        return;
      }
      await reload();
      await openSession(res.sessionId);
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
      setBusy(false);
    }
  };

  const hits = query.trim() && index ? index.search(query.trim()) : [];
  const activeSessions = sessions.filter((session) => session.archivedAt === undefined);
  const archivedSessions = sessions.filter((session) => session.archivedAt !== undefined);
  const open = sessions.find((s) => s.id === openId) ?? null;
  const generating = Boolean(open && open.intelligence === 'pending' && !open.intelligenceError);
  const playbackSessionId = open?.id ?? null;

  useEffect(() => {
    setAudioSource(null);
    setPlaybackError(null);
    setCurrentTime(0);
    setAudioDuration(0);
    setPlaybackRate(1);
    setIsPlaying(false);
    if (!playbackSessionId) return;

    let cancelled = false;
    let ownedUrl: string | null = null;
    void assembleSessionAudio(playbackSessionId)
      .then((source) => {
        ownedUrl = source?.url ?? null;
        if (cancelled) {
          if (ownedUrl) revokeSessionAudio(ownedUrl);
          ownedUrl = null;
          return;
        }
        if (!source) return;
        setAudioSource({ ...source, sessionId: playbackSessionId });
      })
      .catch((e) => {
        if (!cancelled) setPlaybackError(humanError(e));
      });

    return () => {
      cancelled = true;
      if (ownedUrl) revokeSessionAudio(ownedUrl);
    };
  }, [playbackSessionId, audioRevision]);

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    const knownDuration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : audioDuration;
    const next = Math.min(knownDuration > 0 ? knownDuration : Number.POSITIVE_INFINITY, Math.max(0, seconds));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    setPlaybackError(null);
    void audio.play().catch((e) => {
      setIsPlaying(false);
      setPlaybackError(humanError(e));
    });
  };

  useEffect(() => {
    if (!playbackSessionId || audioSource?.sessionId !== playbackSessionId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = playbackKeyAction(event.key, event.target as HTMLElement | null);
      if (!action) return;
      event.preventDefault();
      if (action === 'toggle') {
        togglePlayback();
        return;
      }
      const audio = audioRef.current;
      if (!audio) return;
      const delta = action === 'seek-back' ? -SEEK_STEP_MS : SEEK_STEP_MS;
      seekTo(audio.currentTime + delta / 1000);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playbackSessionId, audioSource, audioDuration]);

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

  // O(highlights x segments) with two sorts: compute once per data change, not
  // once per render (a 1s interval re-renders this view while summaries stream).
  const contextualHighlights = useMemo(
    () => highlightsWithContext(openHighlights, openSegments),
    [openHighlights, openSegments],
  );
  // Legacy rows without a kind read back as 'highlight' (store backfill), so the
  // ?? here only guards direct callers.
  const highlightKindsPresent = useMemo(
    () =>
      HIGHLIGHT_KINDS.filter((kind) =>
        contextualHighlights.some(({ highlight }) => (highlight.kind ?? 'highlight') === kind),
      ),
    [contextualHighlights],
  );
  const visibleHighlights = useMemo(
    () =>
      highlightFilter === 'all'
        ? contextualHighlights
        : contextualHighlights.filter(
            ({ highlight }) => (highlight.kind ?? 'highlight') === highlightFilter,
          ),
    [contextualHighlights, highlightFilter],
  );
  const highlightExtras = useMemo(
    () =>
      contextualHighlights.map(({ highlight, segment }) => ({
        startMs: highlight.startMs,
        ...(highlight.label ? { label: highlight.label } : {}),
        ...(highlight.kind ? { kind: highlight.kind } : {}),
        ...(segment?.text ? { text: segment.text } : {}),
      })),
    [contextualHighlights],
  );
  // Display names, not raw stored labels: two aliases merged onto one name are
  // one speaker, and the list must not show that name twice.
  const speakers = useMemo(
    () => (open ? distinctSpeakers(applyStoredSpeakerNames(openSegments, open.speakerNames)) : []),
    [open, openSegments],
  );

  const exportOne = async (format: ExportFormat) => {
    if (!open) return;
    setBusy(true);
    setActionError(null);
    setCopied(false);
    try {
      await downloadExport(open, openSegments, format, { highlights: highlightExtras }, exportOptions);
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const setExportOption = (key: keyof TranscriptExportOptions, on: boolean) => {
    setCopied(false);
    setExportOptions((prev) => ({ ...prev, [key]: on }));
  };

  const copyTranscript = async () => {
    if (!open) return;
    // Checked here so the message is specific: a rejected writeText() only
    // reaches humanError() as the generic failure line.
    if (!clipboardWriter()) {
      setActionError('Clipboard is unavailable here — use Export .md instead.');
      return;
    }
    setBusy(true);
    setActionError(null);
    setCopied(false);
    try {
      await copyMarkdownExport(open, openSegments, exportOptions, { highlights: highlightExtras });
      setCopied(true);
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshOpen = async (id: string) => {
    const version = ++openReadVersionRef.current;
    const highlightVersion = ++openHighlightVersionRef.current;
    const token: SessionReadToken = { sessionId: id, version };
    const highlightToken: SessionReadToken = { sessionId: id, version: highlightVersion };
    const [row, data] = await Promise.all([getSession(id), loadOpenSessionData(id)]);
    const current = openReadVersionRef.current;
    if (!canApplySessionRead(token, openIdRef.current, current)) return;
    if (row) {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === id);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = row;
        return next;
      });
    }
    searchCache.applySegments(id, data.segments);
    setIndex(searchCache.createIndex());
    if (!data.segmentsError) setOpenSegments((prev) => mergeSegments(data.segments, prev));
    const currentHighlights = openHighlightVersionRef.current;
    if (canApplySessionRead(highlightToken, openIdRef.current, currentHighlights) && !data.highlightsError) {
      setOpenHighlights(data.highlights);
    }
    if (data.segmentsError) setActionError(humanError(data.segmentsError));
    if (canApplySessionRead(highlightToken, openIdRef.current, currentHighlights) && data.highlightsError) {
      setActionError(humanError(data.highlightsError));
    }
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
        templateId: regenerateTemplateId,
      } satisfies ToBackground)) as Ack;
      if (!res?.ok) setActionError(res?.error ?? humanError('Unknown error'));
      await refreshOpen(open.id);
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const archiveOpen = async () => {
    if (!open) return;
    if (!canDeleteSession(open.status)) {
      setActionError('Stop the recording before archiving this meeting.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'ARCHIVE_SESSION',
        sessionId: open.id,
      } satisfies ToBackground)) as Ack;
      if (!res?.ok) {
        setActionError(res?.error ?? humanError('Archive failed'));
        return;
      }
      openIdRef.current = null;
      openReadVersionRef.current += 1;
      openHighlightVersionRef.current += 1;
      setOpenId(null);
      setOpenHighlights([]);
      await reload();
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const restoreArchived = async (session: StoredSession) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'RESTORE_SESSION',
        sessionId: session.id,
      } satisfies ToBackground)) as Ack;
      if (!res?.ok) {
        setActionError(res?.error ?? humanError('Restore failed'));
        return;
      }
      await reload();
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteArchived = async (session: StoredSession) => {
    if (busy) return;
    if (!confirm(`Delete "${session.title}" and its transcript forever? This cannot be undone.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteSession(session.id);
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
        templateId: regenerateTemplateId,
      } satisfies ToBackground)) as Ack;
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
    const typed = window.prompt(`Rename speaker ${displayName}`, displayName);
    if (typed === null) return;
    const to = typed.trim();
    // Renaming onto a name another speaker already uses is a merge: both
    // original aliases end up pointing at the same display name.
    const collision = speakerMergeTarget(openSegments, open.speakerNames, from, to);
    if (collision && !confirm(`Merge ${displayName} into ${collision}?`)) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'RENAME_SPEAKER',
        sessionId: open.id,
        from,
        to,
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

  const editSegment = async (segment: TranscriptSegment) => {
    if (!open || busy) return;
    const typed = window.prompt('Edit transcript segment', segment.text);
    if (typed === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'EDIT_SEGMENT',
        sessionId: open.id,
        segmentId: segment.id,
        text: typed,
      } satisfies ToBackground)) as Ack;
      if (!res?.ok) setActionError(res?.error ?? humanError('Transcript edit failed'));
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    const hasAudio = audioSource?.sessionId === open.id;
    const activeSegment = hasAudio ? playingSegmentIndex(openSegments, currentTime * 1000) : -1;
    return (
      <section>
        <button class="st-chip" onClick={() => { openIdRef.current = null; openReadVersionRef.current += 1; openHighlightVersionRef.current += 1; setOpenId(null); }} style={{ marginBottom: 8 }}>← Library</button>
        <div class="st-detail-title">
          <h1 style={{ fontSize: 15, margin: '0 0 4px' }}>{open.title}</h1>
          <button type="button" class="st-icon-btn" aria-label="Rename session" disabled={busy} onClick={() => void renameSession()}>✎</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--st-muted)', margin: '0 0 8px' }}>
          {dateLabel(open.startedAt)} · {durationLabel(open)} · {open.platform} · {open.status}
          {(open.providerId || open.model) && <> · {[open.providerId, open.model].filter(Boolean).join(' / ')}</>}
          {open.costUsd !== undefined && <> · {formatUsd(open.costUsd)} est.</>}
        </p>
        {hasAudio && (
          <section
            class="st-detail-card"
            aria-label="Audio playback"
            style={{ marginBottom: 12 }}
          >
            <audio
              key={audioSource.url}
              ref={audioRef}
              preload="metadata"
              style={{ display: 'none' }}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) setAudioDuration(duration);
                event.currentTarget.playbackRate = playbackRate;
              }}
              onDurationChange={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) setAudioDuration(duration);
              }}
              onTimeUpdate={(event) => {
                const time = event.currentTarget.currentTime;
                if (Number.isFinite(time)) setCurrentTime(time);
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onError={() => {
                setIsPlaying(false);
                setPlaybackError('Recording audio could not be played.');
              }}
            >
              <source src={audioSource.url} type={audioSource.mimeType} />
            </audio>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                class="st-chip"
                title="Play or pause (Escape)"
                onClick={togglePlayback}
              >
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <label class="st-hint" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                Speed
                <select
                  class="st-select"
                  aria-label="Playback speed"
                  value={playbackRate}
                  style={{ width: 'auto', padding: '5px 8px' }}
                  onChange={(event) => {
                    const rate = Number(event.currentTarget.value);
                    if (!PLAYBACK_RATES.includes(rate as (typeof PLAYBACK_RATES)[number])) return;
                    setPlaybackRate(rate);
                    if (audioRef.current) audioRef.current.playbackRate = rate;
                  }}
                >
                  {PLAYBACK_RATES.map((rate) => (
                    <option key={rate} value={rate}>{rate}×</option>
                  ))}
                </select>
              </label>
              <span
                aria-label="Playback time"
                style={{ marginLeft: 'auto', color: 'var(--st-muted)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
              >
                {formatElapsed(currentTime * 1000)} / {formatElapsed(audioDuration * 1000)}
              </span>
            </div>
          </section>
        )}
        {playbackError && <p class="st-banner st-banner--error">{playbackError}</p>}
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
            {highlightKindsPresent.length > 1 && (
              <div role="group" aria-label="Filter highlights by kind" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 8px' }}>
                <button
                  type="button"
                  class="st-chip"
                  aria-pressed={highlightFilter === 'all'}
                  style={highlightFilter === 'all' ? { background: 'var(--st-tint)' } : undefined}
                  onClick={() => setHighlightFilter('all')}
                >
                  All
                </button>
                {highlightKindsPresent.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    class="st-chip"
                    title={`Filter: ${kind}`}
                    aria-label={`Filter highlights: ${kind}`}
                    aria-pressed={highlightFilter === kind}
                    style={highlightFilter === kind ? { background: 'var(--st-tint)' } : undefined}
                    onClick={() => setHighlightFilter(kind)}
                  >
                    {highlightKindEmoji(kind)}
                  </button>
                ))}
              </div>
            )}
            <ol class="st-highlights">
              {visibleHighlights.map(({ highlight, segment }) => (
                <li key={highlight.id}>
                  <span class="st-highlight-time">{formatClock(highlight.startMs)}</span>
                  <span class="st-highlight-text">
                    <span>
                      {highlightKindEmoji(highlight.kind)}
                      {highlight.label && ' '}
                      {highlight.label && <strong>{highlight.label}</strong>}
                    </span>
                    {segment?.text && <span>{segment.text}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <nav class="st-seg" style={{ margin: '0 0 10px' }}>
          {(['transcript', 'ask'] as const).map((p) => (
            <button key={p} type="button" aria-selected={detailPane === p} onClick={() => setDetailPane(p)}>
              {p === 'ask' ? 'Ask' : 'Transcript'}
            </button>
          ))}
        </nav>
        {detailPane === 'ask' ? (
          <ChatView key={open.id} sessionId={open.id} />
        ) : (
        <>
        <div
          class="st-radios"
          role="group"
          aria-label="Export options"
          style={{ margin: '0 0 8px' }}
        >
          {EXPORT_OPTIONS.map(({ key, label }) => (
            <label class="st-check" key={key}>
              <input
                data-testid={`export-option-${key}`}
                type="checkbox"
                checked={exportOptions[key]}
                onChange={(event) =>
                  setExportOption(key, (event.currentTarget as HTMLInputElement).checked)
                }
              />{' '}
              {label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['md', 'json', 'srt', 'vtt'] as const).map((f) => (
            <button class="st-chip" key={f} disabled={busy} onClick={() => void exportOne(f)}>Export .{f}</button>
          ))}
          <button class="st-chip" disabled={busy} onClick={() => void exportOne('notebooklm')}>Export for NotebookLM</button>
          <button data-testid="copy-transcript" class="st-chip" disabled={busy} onClick={() => void copyTranscript()}>Copy transcript</button>
          <select
            data-testid="regenerate-template"
            class="st-select"
            aria-label="Summary template for regeneration"
            value={regenerateTemplateId}
            disabled={busy}
            style={{ width: 'auto', maxWidth: 180, padding: '5px 8px' }}
            onChange={(event) => setRegenerateTemplateId(event.currentTarget.value)}
          >
            <option value="">{DEFAULT_TEMPLATE_LABEL}</option>
            {summaryTemplates.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
          <button class="st-chip" disabled={busy} onClick={() => void regenerateSummary()}>Regenerate summary</button>
          <button class="st-chip" disabled={busy} onClick={() => void archiveOpen()}>Archive</button>
        </div>
        {copied && <p data-testid="copy-notice" class="st-banner st-banner--success">Transcript copied to the clipboard.</p>}
        {actionError && <p data-testid="library-error" class="st-banner st-banner--error">{actionError}</p>}
        {openSegments.length === 0 ? (
          <p class="st-empty">No transcript segments for this meeting.</p>
        ) : (
          <ol class="st-segments">
            {openSegments.map((segment, index) => (
              <li
                key={segment.id}
                class={index === activeSegment ? 'st-segment--playing' : undefined}
                style={index === activeSegment ? { background: 'var(--st-tint)' } : undefined}
              >
                {hasAudio ? (
                  <button
                    type="button"
                    class="st-time"
                    aria-label={`Seek to ${formatElapsed(segment.startMs)}`}
                    onClick={() => seekTo(segment.startMs / 1000)}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: '2px 0 0',
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {formatElapsed(segment.startMs)}
                  </button>
                ) : (
                  <span class="st-time">{formatElapsed(segment.startMs)}</span>
                )}
                <span
                  class="st-text"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    ...(segment.text === '[transcription failed]' ? { color: 'var(--st-danger)' } : {}),
                  }}
                >
                  {segment.speaker && <strong>{segment.speaker}: </strong>}
                  {segment.text}
                </span>
                <button
                  type="button"
                  class="st-icon-btn"
                  aria-label={`Edit transcript segment at ${formatElapsed(segment.startMs)}`}
                  disabled={busy}
                  onClick={() => void editSegment(segment)}
                >
                  ✎
                </button>
              </li>
            ))}
          </ol>
        )}
        </>
        )}
      </section>
    );
  }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>Library</h1>
        <button
          type="button"
          class="st-chip"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => importInputRef.current?.click()}
        >
          Import
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".vtt,.srt,.txt,.json"
          aria-label="Import transcript file"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void importTranscript(file);
          }}
        />
      </div>
      <section class="st-detail-card" aria-label="Ask your meetings" style={{ marginBottom: 10 }}>
        <h2>Ask your meetings</h2>
        <form
          style={{ display: 'flex', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void askLibrary();
          }}
        >
          <input
            data-testid="library-ask-input"
            type="text"
            class="st-input"
            style={{ flex: 1, maxWidth: 'none' }}
            placeholder="Ask across all meetings…"
            value={askQuery}
            disabled={askPending}
            onInput={(e) => setAskQuery((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="st-btn" disabled={askPending || !askQuery.trim()}>
            Ask
          </button>
        </form>
        {askPending && (
          <p class="st-hint st-gen" aria-live="polite" style={{ margin: '8px 0 0' }}>
            <span class="st-gen-dot" />
            <span>Searching your meetings…</span>
          </p>
        )}
        {askError && (
          <p data-testid="library-ask-error" class="st-banner st-banner--error" style={{ marginTop: 8 }}>
            {askError}
          </p>
        )}
        {askAnswer !== null && (
          <div style={{ marginTop: 8 }}>
            <p
              data-testid="library-ask-answer"
              style={{ whiteSpace: 'pre-wrap', fontSize: 13, margin: 0, background: 'var(--st-tint)', borderRadius: 6, padding: '6px 8px' }}
            >
              {askAnswer}
            </p>
            {askSources.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                <span class="st-hint">Sources</span>
                {askSources.map((source) => (
                  <button
                    key={source.sessionId}
                    type="button"
                    class="st-chip"
                    data-testid="library-ask-source"
                    onClick={() => void openSession(source.sessionId)}
                  >
                    {source.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
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
      ) : activeSessions.length === 0 ? (
        <p data-testid="library-empty" class="st-empty">No meetings yet. Record a tab from the popup — past sessions will show up here.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeSessions.map((s) => (
            <li key={s.id}>
              <button class="st-session" onClick={() => void openSession(s.id)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div class="st-title">{s.title}</div>
                  <div class="st-meta">{sessionCardMeta(s)}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {archivedSessions.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ color: 'var(--st-muted)', cursor: 'pointer', fontSize: 13 }}>
            Archived ({archivedSessions.length})
          </summary>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {archivedSessions.map((session) => (
              <li key={session.id} class="st-detail-card" style={{ margin: 0 }}>
                <div class="st-title" style={{ fontSize: 13.5, fontWeight: 600 }}>{session.title}</div>
                <div class="st-meta" style={{ color: 'var(--st-muted)', fontSize: 12, marginTop: 2 }}>
                  {sessionCardMeta(session)}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  <button class="st-chip" disabled={busy} onClick={() => void restoreArchived(session)}>Restore</button>
                  <button data-testid="delete-session" class="st-chip st-chip--danger" disabled={busy} onClick={() => void deleteArchived(session)}>Delete forever</button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {actionError && !open && <p data-testid="library-error" class="st-banner st-banner--error" style={{ marginTop: 10 }}>{actionError}</p>}
    </section>
  );
}
