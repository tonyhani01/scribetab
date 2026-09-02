import {
  addCostUsd,
  getTranscriptionProvider,
  isContentfulSegmentText,
  reconcileDiarization,
  sttCostUsd,
  type ProviderConfig,
} from '@scribetab/shared';
import { getSegments, putSegments } from './segmentStore';
import { getSession, updateSession } from './sessionStore';
import type { Settings } from './settings';

const WHOLE_FILE_TIMEOUT_MS = 600_000;

/**
 * One diarization pass over the whole meeting audio. Chunk-scoped "Speaker N"
 * labels are useless across chunks; diarizing the assembled recording once
 * yields session-global speakers, which are reconciled onto the stored segments
 * by timestamp. Best-effort: any failure is logged and swallowed.
 *
 * @returns how many stored segments gained a speaker label.
 */
export async function runWholeFileDiarization(
  sessionId: string,
  audio: { blob: Blob; seconds: number; ext: 'wav' | 'ogg' },
  settings: Settings,
): Promise<number> {
  try {
    if (!settings.providerId || audio.blob.size === 0) return 0;
    const cfg: ProviderConfig = {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl || undefined,
      model: settings.model.trim() || undefined,
      diarize: settings.diarize,
      timeoutMs: WHOLE_FILE_TIMEOUT_MS,
    };
    const result = await getTranscriptionProvider(settings.providerId).transcribe(
      {
        audio: await audio.blob.arrayBuffer(),
        mimeType: audio.ext === 'ogg' ? 'audio/ogg' : 'audio/wav',
        language: settings.language || undefined,
      },
      cfg,
    );
    const diarized = (result.segments ?? []).filter((s) => isContentfulSegmentText(s.text));
    if (diarized.length === 0) return 0;

    const stored = await getSegments(sessionId);
    const reconciled = reconcileDiarization(stored, diarized);
    const speakerById = new Map<string, string>();
    for (const [i, seg] of reconciled.entries()) {
      if (seg.speaker !== stored[i]?.speaker && seg.speaker) speakerById.set(seg.id, seg.speaker);
    }
    // Re-read right before writing: redaction may have rewritten `text` while
    // the network call was in flight, and only `speaker` is ours to change.
    const fresh = (await getSegments(sessionId)).filter((seg) => speakerById.has(seg.id));
    const changed = fresh.map((seg) => ({ ...seg, speaker: speakerById.get(seg.id) }));
    if (changed.length > 0) await putSegments(changed);

    const usd = result.costUsd ?? sttCostUsd(
      settings.providerId,
      Math.round(audio.seconds * 1000),
      settings.model || undefined,
    );
    if (usd !== undefined && usd > 0) {
      const session = await getSession(sessionId);
      if (session) {
        // runFinalizeIntelligence may already have written the session total
        // from the first pass; keep it in step with providerCostUsd.
        await updateSession(sessionId, {
          providerCostUsd: addCostUsd(session.providerCostUsd, usd),
          ...(session.costUsd != null ? { costUsd: addCostUsd(session.costUsd, usd) } : {}),
        });
      }
    }
    return changed.length;
  } catch (e) {
    console.warn('whole-file diarization failed', e);
    return 0;
  }
}
