import {
  addCostUsd,
  audioTranscribedMs,
  estimateTokens,
  getLlmProvider,
  llmCostUsd,
  llmEndpoint,
  originPattern,
  redactSegments,
  sttCostUsd,
  summarizeMeeting,
  summaryToMarkdown,
  type ChatMessage,
  type SessionSummary,
} from '@scribetab/shared';
import { getSegments, putSegments } from './segmentStore';
import { getSession, listSessions, updateSession } from './sessionStore';
import { getSettings, type Settings } from './settings';

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
  await updateSession(sessionId, { intelligence: 'pending' });
}

export async function scheduleFinalizeIntelligence(
  sessionId: string,
  settings: Settings,
): Promise<void> {
  await markIntelligencePending(sessionId, settings);
  void runFinalizeIntelligence(sessionId, settings).catch(() => {});
}

export async function retryPendingIntelligence(): Promise<void> {
  const settings = await getSettings();
  const sessions = await listSessions();
  for (const s of sessions) {
    if (s.status !== 'complete' || s.intelligence !== 'pending') continue;
    if (!llmConfigured(settings)) {
      await updateSession(s.id, { intelligence: null }).catch(() => {});
      continue;
    }
    await runFinalizeIntelligence(s.id, settings).catch(() => {});
  }
}

/**
 * After a successful complete-finalize: optional at-rest redaction, one
 * structured LLM summary, and a session cost total (transcribed STT minutes
 * + LLM tokens). Failures here must not fail capture finalize.
 */
export async function runFinalizeIntelligence(sessionId: string, settings: Settings): Promise<void> {
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
      const complete = async (messages: ChatMessage[]) => {
        const out = await provider.complete(messages, cfg);
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
        summary = await summarizeMeeting(complete, forLlm, {
          model: settings.llmModel.trim() || undefined,
        });
        intelligence = null;
      } catch {
        intelligence = 'pending';
      }
    }
  }

  await updateSession(sessionId, {
    costUsd: costUsd === undefined ? existing?.costUsd ?? null : costUsd,
    intelligence,
    ...(summary ? { summary, summaryMarkdown: summaryToMarkdown(summary) } : {}),
  });
}
