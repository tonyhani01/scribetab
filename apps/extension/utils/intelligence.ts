import {
  estimateTokens,
  getLlmProvider,
  llmCostUsd,
  pcmWavDurationMs,
  redact,
  sttCostUsd,
  summarizeMeeting,
  type ChatMessage,
} from '@scribetab/shared';
import { getChunksForSession, type ChunkRow } from './chunkStore';
import { getSegments, putSegments } from './segmentStore';
import { updateSession } from './sessionStore';
import type { Settings } from './settings';

export function audioDurationMs(chunks: ChunkRow[]): number {
  let maxEnd = 0;
  for (const c of chunks) {
    const end =
      (c.startOffsetSamples / c.sampleRate) * 1000 +
      pcmWavDurationMs(c.wav.byteLength, c.sampleRate);
    if (end > maxEnd) maxEnd = end;
  }
  return Math.round(maxEnd);
}

function llmConfigured(settings: Settings): boolean {
  if (settings.llmProviderId === '') return false;
  if (settings.llmProviderId === 'custom' && !settings.llmBaseUrl.trim()) return false;
  if (settings.llmProviderId !== 'custom' && !settings.llmApiKey) return false;
  return true;
}

/**
 * After a successful complete-finalize: optional at-rest redaction, LLM
 * summary + action items, and a session cost total (STT minutes + LLM tokens).
 * Failures here must not fail capture finalize — the transcript is already saved.
 */
export async function runFinalizeIntelligence(
  sessionId: string,
  settings: Settings,
  opts: { sttDurationMs?: number } = {},
): Promise<void> {
  const extraTerms = settings.redactTerms;
  let segments = await getSegments(sessionId);

  if (settings.redactAtRest && segments.length > 0) {
    segments = segments.map((s) => ({ ...s, text: redact(s.text, { extraTerms }) }));
    await putSegments(segments);
  }

  const chunks = await getChunksForSession(sessionId);
  const durationMs = opts.sttDurationMs ?? audioDurationMs(chunks);
  let costUsd = settings.providerId ? sttCostUsd(settings.providerId, durationMs) : 0;

  let summaryMarkdown: string | undefined;
  if (llmConfigured(settings) && segments.length > 0) {
    const forLlm = segments.map((s) => ({
      ...s,
      text: redact(s.text, { extraTerms }),
    }));
    const provider = getLlmProvider(settings.llmProviderId);
    const cfg = {
      apiKey: settings.llmApiKey,
      baseUrl: settings.llmBaseUrl.trim() || undefined,
      model: settings.llmModel.trim() || undefined,
    };
    const complete = async (messages: ChatMessage[]) => {
      const out = await provider.complete(messages, cfg);
      const prompt = messages.map((m) => m.content).join('\n');
      costUsd += llmCostUsd(
        settings.llmProviderId,
        estimateTokens(prompt),
        estimateTokens(out),
      );
      return out;
    };
    try {
      const md = await summarizeMeeting(complete, forLlm);
      if (md) summaryMarkdown = md;
    } catch {
      // Keep STT cost; skip summary. Capture already finalized.
    }
  }

  await updateSession(sessionId, {
    costUsd,
    ...(summaryMarkdown ? { summaryMarkdown } : {}),
  });
}
