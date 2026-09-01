import { WAV_HEADER_BYTES } from '../wav.js';
import { hintsToPrompt } from '../vocab.js';
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types.js';

export interface OpenAiCompatibleOptions {
  id: string;
  defaultBaseUrl?: string;   // absent → cfg.baseUrl is required (custom/localhost)
  defaultModel: string;
  requiresApiKey?: boolean;  // default true; false for localhost servers
  form?: Record<string, string> | ((model: string) => Record<string, string>); // extra multipart fields
}

interface VerboseJson {
  text?: string;
  segments?: { start: number; end: number; text: string }[];
  usage?: { cost?: unknown; seconds?: unknown };
}

const TIMEOUT_MS = 120_000;

/**
 * Builds a TranscriptionProvider for any endpoint speaking the OpenAI
 * `POST {base}/audio/transcriptions` multipart dialect. This includes the
 * local-model path: whisper.cpp server, Speaches/faster-whisper, LM Studio.
 */
export function openAiCompatible(opts: OpenAiCompatibleOptions): TranscriptionProvider {
  return {
    id: opts.id,
    async transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult> {
      // Official providers pin defaultBaseUrl so a leftover custom URL cannot leak keys.
      const baseUrl = (opts.defaultBaseUrl ?? cfg.baseUrl)?.replace(/\/+$/, '');
      if (!baseUrl) throw new Error(`${opts.id}: baseUrl is required`);
      if ((opts.requiresApiKey ?? true) && !cfg.apiKey) {
        throw new Error(`${opts.id}: apiKey is required`);
      }
      if (req.audio.byteLength <= WAV_HEADER_BYTES) {
        throw new Error(`${opts.id}: empty audio`);
      }

      const model = cfg.model ?? opts.defaultModel;
      const extra = typeof opts.form === 'function' ? opts.form(model) : (opts.form ?? {});
      const form = new FormData();
      form.append('file', new Blob([req.audio], { type: req.mimeType }), 'audio.wav');
      form.append('model', model);
      for (const [k, v] of Object.entries(extra)) form.append(k, v);
      if (req.language) form.append('language', req.language);
      // Whisper's context prompt is how custom vocabulary reaches the model;
      // capped locally so an over-long list cannot make every chunk fail with 400.
      const prompt = hintsToPrompt(cfg.vocabHints ?? []);
      if (prompt) form.append('prompt', prompt);

      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = redactKey(await res.text().catch(() => ''), cfg.apiKey).slice(0, 300);
        throw new Error(`${opts.id}: HTTP ${res.status} ${body}`);
      }
      let json: VerboseJson;
      try {
        json = (await res.json()) as VerboseJson;
      } catch {
        throw new Error(`${opts.id}: malformed response`);
      }
      if (!json || typeof json !== 'object' || typeof json.text !== 'string') {
        throw new Error(`${opts.id}: malformed response`);
      }
      const costUsd = parseCostUsd(json.usage?.cost);
      return {
        text: json.text,
        segments: json.segments?.map((s) => ({
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(s.end * 1000),
          text: s.text,
        })),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}

function redactKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[key]') : text;
}

function parseCostUsd(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return v;
}
