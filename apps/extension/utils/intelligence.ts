import {
  addCostUsd,
  audioTranscribedMs,
  buildChatMessages,
  estimateTokens,
  getLlmProvider,
  llmCostUsd,
  llmEndpoint,
  originPattern,
  redactSegments,
  sttCostUsd,
  summarizeMeetingLong,
  summaryToMarkdown,
  type ChatMessage,
  type LlmProvider,
  type ProviderConfig,
  type SessionSummary,
} from '@scribetab/shared';
import type { ChatAskAck, ToSidePanel } from './messages';
import { getSegments, putSegments } from './segmentStore';
import { getSession, listSessions, updateSession, type StoredSession } from './sessionStore';
import { humanError } from './userError';
import { getSettings, personalContextPromptLine, summaryGuidance, type Settings } from './settings';
import { notifyReady } from './notify';

const SUMMARY_DELTA_MIN_MS = 150;

export function llmConfigured(settings: Settings): boolean {
  if (settings.llmProviderId === '') return false;
  if (settings.llmProviderId === 'custom' && !settings.llmBaseUrl.trim()) return false;
  if (settings.llmProviderId !== 'custom' && !settings.llmApiKey) return false;
  return true;
}

export function llmOrigin(settings: Settings): string {
  return llmEndpoint(
    settings.llmProviderId,
    settings.llmProviderId === 'custom' ? settings.llmBaseUrl.trim() || undefined : undefined,
  );
}

export async function llmOriginGranted(settings: Settings): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(llmOrigin(settings))] });
  } catch {
    return false;
  }
}

/**
 * Durable "work remains" marker. Awaited (cheap IDB write) so STOP can return
 * without waiting on the LLM; a SW death only delays the summary.
 */
export async function markIntelligencePending(sessionId: string, settings: Settings): Promise<void> {
  if (!llmConfigured(settings)) return;
  await updateSession(sessionId, {
    intelligence: 'pending',
    intelligenceError: null,
    intelligenceStartedAt: Date.now(),
    // A manual regeneration (and a newly finalized session) starts a fresh
    // durable retry sequence rather than inheriting stale backoff state.
    intelligenceRetryCount: null,
    intelligenceNextRetryAt: null,
  });
}

export async function scheduleFinalizeIntelligence(
  sessionId: string,
  settings: Settings,
): Promise<void> {
  await markIntelligencePending(sessionId, settings);
  void runFinalizeIntelligence(sessionId, settings).catch(() => {});
}

/** Retry backoff: 1m, 5m, 25m, then hourly — capped so we stop hammering a dead endpoint. */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 25 * 60_000, 60 * 60_000] as const;
function backoffForFailureCount(failures: number): number {
  const idx = Math.min(Math.max(failures - 1, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[idx] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
}

function retryPatch(row: StoredSession | undefined): Pick<StoredSession, 'intelligenceRetryCount' | 'intelligenceNextRetryAt'> {
  const failures = Math.max(0, row?.intelligenceRetryCount ?? 0) + 1;
  return {
    intelligenceRetryCount: failures,
    intelligenceNextRetryAt: Date.now() + backoffForFailureCount(failures),
  };
}

export async function retryPendingIntelligence(): Promise<void> {
  const settings = await getSettings();
  const sessions = await listSessions();
  const now = Date.now();
  for (const s of sessions) {
    if (s.status !== 'complete' || s.intelligence !== 'pending') continue;
    if (!llmConfigured(settings)) {
      await updateSession(s.id, {
        intelligence: null,
        intelligenceRetryCount: null,
        intelligenceNextRetryAt: null,
      }).catch(() => {});
      continue;
    }
    // Respect the backoff window; skip sessions whose next attempt is in the future.
    const nextAt = s.intelligenceNextRetryAt;
    if (typeof nextAt === 'number' && nextAt > now) continue;
    await updateSession(s.id, { intelligenceError: null, intelligenceStartedAt: Date.now() });
    await runFinalizeIntelligence(s.id, settings).catch(() => {});
  }
}

/**
 * After a successful complete-finalize: optional at-rest redaction, one
 * structured LLM summary, and a session cost total (transcribed STT minutes
 * + LLM tokens). Failures here must not fail capture finalize.
 */
export async function runFinalizeIntelligence(
  sessionId: string,
  settings: Settings,
  templateId?: string,
): Promise<void> {
  const extraTerms = settings.redactTerms;
  let segments = await getSegments(sessionId);

  if (settings.redactAtRest && segments.length > 0) {
    segments = redactSegments(segments, { extraTerms });
    await putSegments(segments);
  }

  const existing = await getSession(sessionId);
  const durationMs = audioTranscribedMs(segments);
  const tableStt = settings.providerId
    ? sttCostUsd(settings.providerId, durationMs, settings.model || undefined)
    : 0;
  // Provider-reported STT (OpenRouter usage.cost) beats an unknown rate table.
  const stt = existing?.providerCostUsd ?? tableStt;

  let costUsd: number | undefined = stt;
  let summary: SessionSummary | undefined;
  let intelligence: 'pending' | 'needs-permission' | null = null;
  let intelligenceError: string | null = null;
  let retry: Pick<StoredSession, 'intelligenceRetryCount' | 'intelligenceNextRetryAt'> = {
    intelligenceRetryCount: null,
    intelligenceNextRetryAt: null,
  };

  if (llmConfigured(settings) && segments.length > 0) {
    if (!(await llmOriginGranted(settings))) {
      intelligence = 'needs-permission';
    } else {
      const forLlm = settings.redactAtRest
        ? segments
        : redactSegments(segments, { extraTerms });
      const provider = getLlmProvider(settings.llmProviderId);
      const cfg = {
        apiKey: settings.llmApiKey,
        baseUrl: settings.llmProviderId === 'custom' ? settings.llmBaseUrl.trim() || undefined : undefined,
        model: settings.llmModel.trim() || undefined,
      };
      const runId = crypto.randomUUID();
      const emitDelta = createDeltaEmitter(sessionId, runId);
      const complete = async (messages: ChatMessage[]) => {
        const out = await completePreferringStream(provider, messages, cfg, (text) => {
          emitDelta('summary', text);
        });
        const prompt = messages.map((m) => m.content).join('\n');
        const added = llmCostUsd(
          settings.llmProviderId,
          estimateTokens(prompt),
          estimateTokens(out),
          settings.llmModel || undefined,
        );
        costUsd = addCostUsd(costUsd, added);
        return out;
      };
      try {
        // Long meetings use map-reduce so nothing is silently dropped by the
        // 24k-char clip; short ones keep the single-pass call.
        summary = await summarizeMeetingLong(complete, forLlm, {
          guidance: summaryGuidance(settings, templateId),
          model: settings.llmModel.trim() || undefined,
          personalContext: settings.personalContext,
        });
        intelligence = null;
      } catch (e) {
        // Keep accumulated cost. Retry later.
        intelligence = 'pending';
        intelligenceError = humanError(e);
        retry = retryPatch(existing);
      }
    }
  }

  await updateSession(sessionId, {
    costUsd: costUsd === undefined ? existing?.costUsd ?? null : costUsd,
    intelligence,
    intelligenceError,
    ...retry,
    ...(summary ? { summary, summaryMarkdown: summaryToMarkdown(summary) } : {}),
  });
  if (summary) {
    notifyReady('summary', existing?.title ?? 'Untitled meeting', settings.notifyOnReady);
  }
}

/** Q/A turns from the panel kept for the follow-up prompt. Prompt cost only — cap it. */
export const CHAT_HISTORY_MAX_TURNS = 8;

/**
 * Drop malformed turns and keep only the most recent exchanges. The history
 * crosses the extension message boundary, so it is validated like any other
 * untrusted payload even though our own panel sends it.
 */
export function sanitizeChatHistory(input: unknown): { q: string; a: string }[] {
  if (!Array.isArray(input)) return [];
  const turns = input.filter(
    (t): t is { q: string; a: string } =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as { q?: unknown }).q === 'string' &&
      typeof (t as { a?: unknown }).a === 'string' &&
      (t as { q: string }).q.trim() !== '' &&
      (t as { a: string }).a.trim() !== '',
  );
  return turns.slice(-CHAT_HISTORY_MAX_TURNS).map(({ q, a }) => ({ q, a }));
}

/**
 * One transcript-chat turn: same redaction, provider, permission gate, and
 * cost accounting as the finalize summary. Works on a live session (segments
 * so far) and on a completed one. The answer is returned to the caller and
 * never persisted.
 */
export async function answerTranscriptQuestion(
  sessionId: string,
  question: string,
  history: unknown,
  settings: Settings,
): Promise<ChatAskAck> {
  if (!llmConfigured(settings)) return { ok: false, error: 'No LLM configured' };
  if (!(await llmOriginGranted(settings))) return { ok: false, error: 'needs-permission' };
  const q = question.trim();
  if (!q) return { ok: false, error: 'Question cannot be empty' };
  const segments = await getSegments(sessionId);
  if (segments.length === 0) {
    return { ok: false, error: 'No transcript yet — ask again once segments appear.' };
  }
  // Same policy as runFinalizeIntelligence: redact-at-rest sessions are already
  // clean on disk; otherwise redact just before the LLM sees the text.
  const forLlm = settings.redactAtRest
    ? segments
    : redactSegments(segments, { extraTerms: settings.redactTerms });
  const provider = getLlmProvider(settings.llmProviderId);
  const cfg: ProviderConfig = {
    apiKey: settings.llmApiKey,
    baseUrl: settings.llmProviderId === 'custom' ? settings.llmBaseUrl.trim() || undefined : undefined,
    model: settings.llmModel.trim() || undefined,
  };
  const messages = buildChatMessages({
    segments: forLlm,
    question: q,
    history: sanitizeChatHistory(history),
    personalContext: personalContextPromptLine(settings),
  });
  try {
    const answer = await provider.complete(messages, cfg);
    const prompt = messages.map((m) => m.content).join('\n');
    const added = llmCostUsd(
      settings.llmProviderId,
      estimateTokens(prompt),
      estimateTokens(answer),
      settings.llmModel || undefined,
    );
    // Cost bookkeeping is best-effort — a failed write must not eat the answer.
    if (added !== undefined) {
      try {
        const row = await getSession(sessionId);
        await updateSession(sessionId, { costUsd: addCostUsd(row?.costUsd ?? undefined, added) });
      } catch {
        // Session row missing or store unavailable — the answer still stands.
      }
    }
    return { ok: true, answer };
  } catch (e) {
    return { ok: false, error: humanError(e) };
  }
}

export function createDeltaEmitter(
  sessionId: string,
  runId: string,
): (phase: 'summary' | 'actions', text: string) => void {
  let lastAt = 0;
  let lastPhase: 'summary' | 'actions' | null = null;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let queued: { phase: 'summary' | 'actions'; text: string } | undefined;

  const send = (phase: 'summary' | 'actions', text: string) => {
    lastAt = Date.now();
    lastPhase = phase;
    const msg: ToSidePanel = {
      target: 'sidepanel',
      type: 'SUMMARY_DELTA',
      sessionId,
      runId,
      phase,
      text,
    };
    try {
      void chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Side panel not open / tests without runtime.
    }
  };

  return (phase, text) => {
    const now = Date.now();
    // Same-phase updates are throttled; a phase change always sends so the
    // two-phase label cannot be dropped by a trailing-send-not-required policy.
    if (phase !== lastPhase || now - lastAt >= SUMMARY_DELTA_MIN_MS) {
      send(phase, text);
      return;
    }
    queued = { phase, text };
    if (trailing !== undefined) return;
    trailing = setTimeout(() => {
      trailing = undefined;
      const next = queued;
      queued = undefined;
      if (next) send(next.phase, next.text);
    }, SUMMARY_DELTA_MIN_MS - (now - lastAt));
  };
}

async function completePreferringStream(
  provider: LlmProvider,
  messages: ChatMessage[],
  cfg: ProviderConfig,
  onAccumulated: (text: string) => void,
): Promise<string> {
  if (!provider.stream) return provider.complete(messages, cfg);
  let yielded = false;
  let acc = '';
  try {
    return await provider.stream(messages, cfg, (delta) => {
      yielded = true;
      acc += delta;
      onAccumulated(acc);
    });
  } catch (e) {
    if (yielded) throw e;
    return provider.complete(messages, cfg);
  }
}
