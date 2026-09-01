import { arrayBufferToBase64 } from '../base64.js';
import { sttSpeakerDisplayMap } from '../speakers.js';
import { WAV_HEADER_BYTES } from '../wav.js';
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types.js';

/** Pinned Gemini API origin — adapters and host-permission URLs share this. */
export const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PINNED_URL = `${GOOGLE_API_BASE}/interactions`;
const DEFAULT_MODEL = 'gemini-3.5-transcribe';
const TIMEOUT_MS = 120_000;
const GAP_SPLIT_MS = 1_500;
const MAX_SEGMENT_MS = 12_000;
const EXCERPT_MAX = 200;

interface WordInfo {
  type?: string;
  text?: string;
  speaker?: string;
  start_offset?: unknown;
  end_offset?: unknown;
}

interface InteractionsResponse {
  output_text?: unknown;
  steps?: {
    content?: {
      annotations?: WordInfo[];
    }[];
  }[];
}

/**
 * Google Gemini transcription via the Interactions API.
 * Docs: https://ai.google.dev/gemini-api/docs/transcribe
 *
 * `gemini-3.5-transcribe` is public preview (2026-08-26). Inline base64 `data`
 * is used for our ≤8MiB chunks — the Files API upload flow is not implemented.
 * No text-instruction part: the transcribe model does not need one.
 * Cloud endpoint is pinned; cfg.baseUrl is ignored so keys cannot leak.
 */
export const googleProvider: TranscriptionProvider = {
  id: 'google',
  async transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult> {
    if (!cfg.apiKey) throw new Error('google: apiKey is required');
    if (req.audio.byteLength <= WAV_HEADER_BYTES) throw new Error('google: empty audio');

    const input: Record<string, string>[] = [
      {
        type: 'audio',
        data: arrayBufferToBase64(req.audio),
        mime_type: req.mimeType || 'audio/wav',
      },
    ];
    // Smart mode returns clean formatted text but no word timestamps or
    // diarization, so verbatim (the default) is what the live transcript wants.
    const transcriptionConfig: Record<string, unknown> = {
      mode: cfg.smartMode
        ? { type: 'smart' }
        : { type: 'verbatim', timestamp_granularities: ['word'] },
    };
    if (req.language) transcriptionConfig.language_codes = [req.language];
    const body: Record<string, unknown> = {
      model: cfg.model ?? DEFAULT_MODEL,
      input,
      generation_config: { transcription_config: transcriptionConfig },
    };

    const res = await fetch(PINNED_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const errBody = redactKey(await res.text().catch(() => ''), cfg.apiKey).slice(0, 300);
      throw new Error(`google: HTTP ${res.status} ${errBody}`);
    }

    let json: InteractionsResponse;
    try {
      json = (await res.json()) as InteractionsResponse;
    } catch {
      throw new Error('google: malformed response');
    }
    if (!json || typeof json !== 'object') {
      throw new Error('google: malformed response');
    }
    if (json.output_text != null && typeof json.output_text !== 'string') {
      throw new Error('google: malformed response');
    }

    const outputText = typeof json.output_text === 'string' ? json.output_text : undefined;
    const segments = segmentsFromWordInfo(json);
    const hasUsableSegments = Boolean(segments && segments.length > 0);

    if (!hasUsableSegments && outputText === undefined) {
      throw new Error(`google: unrecognized response ${redactKey(excerpt(json), cfg.apiKey)}`);
    }

    if (hasUsableSegments) {
      const text = outputText?.trim() ? outputText : segments!.map((s) => s.text).join(' ');
      return { text, segments };
    }

    return { text: outputText ?? '', segments: undefined };
  },
};

function redactKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[key]') : text;
}

function excerpt(json: unknown): string {
  try {
    return JSON.stringify(json).slice(0, EXCERPT_MAX);
  } catch {
    return '';
  }
}

function parseOffsetSeconds(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  const withUnit = trimmed.match(/^([0-9]*\.?[0-9]+)s$/i);
  const n = Number(withUnit ? withUnit[1] : trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Coarse-group word_info annotations into segments (speaker, silence, length). */
function segmentsFromWordInfo(json: InteractionsResponse): TranscribeResult['segments'] {
  const words: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];
  for (const step of json.steps ?? []) {
    for (const content of step.content ?? []) {
      for (const a of content.annotations ?? []) {
        if (a.type !== 'word_info') continue;
        const text = typeof a.text === 'string' ? a.text.trim() : '';
        if (!text) continue;
        const start = parseOffsetSeconds(a.start_offset);
        const end = parseOffsetSeconds(a.end_offset);
        if (start === undefined || end === undefined) continue;
        const startMs = Math.round(start * 1000);
        const endMs = Math.max(startMs, Math.round(end * 1000));
        words.push({ startMs, endMs, text, speaker: a.speaker });
      }
    }
  }
  if (words.length === 0) return undefined;

  const labels = sttSpeakerDisplayMap(words.map((w) => w.speaker));
  const flush = (cur: { startMs: number; endMs: number; text: string; speaker?: string }) => ({
    startMs: cur.startMs,
    endMs: Math.max(cur.endMs, cur.startMs),
    text: cur.text,
    speaker: cur.speaker ? labels.get(cur.speaker) : undefined,
  });

  const segs: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];
  let cur = {
    startMs: words[0]!.startMs,
    endMs: words[0]!.endMs,
    text: words[0]!.text,
    speaker: words[0]!.speaker,
  };
  for (const w of words.slice(1)) {
    const gap = w.startMs - cur.endMs;
    const spanMs = Math.max(w.endMs, cur.endMs) - cur.startMs;
    if (w.speaker !== cur.speaker || gap > GAP_SPLIT_MS || spanMs > MAX_SEGMENT_MS) {
      segs.push(flush(cur));
      cur = { startMs: w.startMs, endMs: w.endMs, text: w.text, speaker: w.speaker };
    } else {
      cur.endMs = Math.max(cur.endMs, w.endMs, cur.startMs);
      cur.text = cur.text ? `${cur.text} ${w.text}` : w.text;
    }
  }
  segs.push(flush(cur));
  return segs;
}
