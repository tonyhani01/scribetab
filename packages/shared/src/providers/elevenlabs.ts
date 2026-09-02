import { sttSpeakerDisplayMap } from '../speakers.js';
import { WAV_HEADER_BYTES } from '../wav.js';
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types.js';

/** Pinned ElevenLabs API origin — adapter and host-permission URL share this. */
export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const PINNED_URL = `${ELEVENLABS_API_BASE}/speech-to-text`;
export const ELEVENLABS_DEFAULT_MODEL = 'scribe_v2';
const TIMEOUT_MS = 120_000;

function requestTimeoutMs(cfg: ProviderConfig): number {
  const ms = cfg.timeoutMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : TIMEOUT_MS;
}
const GAP_SPLIT_MS = 1_500;
const MAX_SEGMENT_MS = 12_000;
const EXCERPT_MAX = 200;

interface ScribeWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown; // 'word' | 'spacing' | 'audio_event'
  speaker_id?: unknown;
}

interface ScribeResponse {
  text?: unknown;
  words?: unknown;
}

/**
 * ElevenLabs Scribe v2 batch transcription.
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 *
 * Multipart POST to the pinned /v1/speech-to-text endpoint with `xi-api-key`.
 * Word timestamps are always requested; diarization is on unless cfg.diarize
 * is explicitly false. Speaker ids split segments on speaker turns — that
 * in-chunk information is correct — but Scribe numbers speakers per request,
 * so the "Speaker N" labels are chunk-scoped: the result is flagged
 * `speakerScope: 'chunk'` and the labels are dropped downstream (caption fusion
 * and manual renames supply real names). cfg.baseUrl is ignored so keys cannot
 * leak.
 */
export const elevenlabsProvider: TranscriptionProvider = {
  id: 'elevenlabs',
  async transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult> {
    if (!cfg.apiKey) throw new Error('elevenlabs: apiKey is required');
    if (req.audio.byteLength <= WAV_HEADER_BYTES) throw new Error('elevenlabs: empty audio');

    const form = new FormData();
    form.append('file', new Blob([req.audio], { type: req.mimeType || 'audio/wav' }), 'audio.wav');
    form.append('model_id', cfg.model?.trim() || ELEVENLABS_DEFAULT_MODEL);
    const lang = elevenLabsLanguageCode(req.language);
    if (lang) form.append('language_code', lang);
    form.append('diarize', String(cfg.diarize !== false));
    form.append('timestamps_granularity', 'word');
    form.append('temperature', '0');
    form.append('tag_audio_events', 'true');

    const res = await fetch(PINNED_URL, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey },
      body: form,
      signal: AbortSignal.timeout(requestTimeoutMs(cfg)),
    });
    if (!res.ok) {
      const errBody = redactKey(await res.text().catch(() => ''), cfg.apiKey).slice(0, 300);
      throw new Error(`elevenlabs: HTTP ${res.status} ${errBody}`);
    }

    let json: ScribeResponse;
    try {
      json = (await res.json()) as ScribeResponse;
    } catch {
      throw new Error('elevenlabs: malformed response');
    }
    if (!json || typeof json !== 'object') throw new Error('elevenlabs: malformed response');
    if (json.text != null && typeof json.text !== 'string') {
      throw new Error('elevenlabs: malformed response');
    }
    if (json.words != null && !Array.isArray(json.words)) {
      throw new Error('elevenlabs: malformed response');
    }

    const outputText = typeof json.text === 'string' ? json.text : undefined;
    const segments = segmentsFromWords(Array.isArray(json.words) ? json.words : []);
    if (!segments && outputText === undefined) {
      throw new Error(`elevenlabs: unrecognized response ${redactKey(excerpt(json), cfg.apiKey)}`);
    }
    if (segments) {
      const text = outputText?.trim() ? outputText : segments.map((s) => s.text).join(' ');
      const diarized = segments.some((s) => s.speaker);
      return { text, segments, ...(diarized ? { speakerScope: 'chunk' as const } : {}) };
    }
    return { text: outputText ?? '', segments: undefined };
  },
};

/**
 * ElevenLabs accepts ISO-639-1/639-3 codes, not BCP-47 region tags.
 * `ar-EG` → `ar`, `zh-Hant-TW` → `zh`. Anything that is not a 2–3 letter
 * primary subtag is dropped (auto-detect) rather than sent and rejected.
 */
export function elevenLabsLanguageCode(hint: string | undefined): string | undefined {
  const primary = hint?.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

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

function seconds(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Group Scribe `words` into segments on speaker change, silence, and length. */
function segmentsFromWords(raw: ScribeWord[]): TranscribeResult['segments'] {
  const words: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue;
    if (w.type !== undefined && w.type !== 'word') continue; // skip spacing / audio_event
    const text = typeof w.text === 'string' ? w.text.trim() : '';
    if (!text) continue;
    const start = seconds(w.start);
    const end = seconds(w.end);
    if (start === undefined || end === undefined) continue;
    const startMs = Math.round(start * 1000);
    const endMs = Math.max(startMs, Math.round(end * 1000));
    const speaker = typeof w.speaker_id === 'string' ? w.speaker_id : undefined;
    words.push({ startMs, endMs, text, speaker });
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
  let cur = { ...words[0]! };
  for (const w of words.slice(1)) {
    const gap = w.startMs - cur.endMs;
    const spanMs = Math.max(w.endMs, cur.endMs) - cur.startMs;
    if (w.speaker !== cur.speaker || gap > GAP_SPLIT_MS || spanMs > MAX_SEGMENT_MS) {
      segs.push(flush(cur));
      cur = { ...w };
    } else {
      cur.endMs = Math.max(cur.endMs, w.endMs, cur.startMs);
      cur.text = `${cur.text} ${w.text}`;
    }
  }
  segs.push(flush(cur));
  return segs;
}
