import { arrayBufferToBase64 } from '../base64.js';
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types.js';

const PINNED_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_MODEL = 'gemini-3.5-transcribe';
const TIMEOUT_MS = 120_000;

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

    const input: Record<string, string>[] = [
      {
        type: 'audio',
        data: arrayBufferToBase64(req.audio),
        mime_type: req.mimeType || 'audio/wav',
      },
    ];
    const body: Record<string, unknown> = {
      model: cfg.model ?? DEFAULT_MODEL,
      input,
    };
    if (req.language) {
      body.generation_config = {
        transcription_config: { language_codes: [req.language] },
      };
    }

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
      const errBody = (await res.text().catch(() => '')).slice(0, 300);
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

    return {
      text: json.output_text ?? '',
      segments: segmentsFromWordInfo(json),
    };
  },
};

function parseOffsetSeconds(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  const withUnit = trimmed.match(/^([0-9]*\.?[0-9]+)s$/i);
  const n = Number(withUnit ? withUnit[1] : trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Coarse-group consecutive word_info annotations (same speaker) into segments. */
function segmentsFromWordInfo(json: InteractionsResponse): TranscribeResult['segments'] {
  const words: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];
  for (const step of json.steps ?? []) {
    for (const content of step.content ?? []) {
      for (const a of content.annotations ?? []) {
        if (a.type !== 'word_info') continue;
        const start = parseOffsetSeconds(a.start_offset);
        const end = parseOffsetSeconds(a.end_offset);
        if (start === undefined || end === undefined) continue;
        words.push({
          startMs: Math.round(start * 1000),
          endMs: Math.round(end * 1000),
          text: a.text ?? '',
          speaker: a.speaker,
        });
      }
    }
  }
  if (words.length === 0) return undefined;

  const segs: { startMs: number; endMs: number; text: string }[] = [];
  let cur = {
    startMs: words[0]!.startMs,
    endMs: words[0]!.endMs,
    text: words[0]!.text,
    speaker: words[0]!.speaker,
  };
  for (const w of words.slice(1)) {
    if (w.speaker === cur.speaker) {
      cur.endMs = w.endMs;
      cur.text = cur.text ? `${cur.text} ${w.text}` : w.text;
    } else {
      segs.push({ startMs: cur.startMs, endMs: cur.endMs, text: cur.text });
      cur = { startMs: w.startMs, endMs: w.endMs, text: w.text, speaker: w.speaker };
    }
  }
  segs.push({ startMs: cur.startMs, endMs: cur.endMs, text: cur.text });
  return segs;
}
