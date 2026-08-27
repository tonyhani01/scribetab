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
  form?: Record<string, string>; // extra multipart fields (response_format, …)
}

interface VerboseJson {
  text?: string;
  segments?: { start: number; end: number; text: string }[];
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

      const form = new FormData();
      form.append('file', new Blob([req.audio], { type: req.mimeType }), 'audio.wav');
      form.append('model', cfg.model ?? opts.defaultModel);
      for (const [k, v] of Object.entries(opts.form ?? {})) form.append(k, v);
      if (req.language) form.append('language', req.language);

      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`${opts.id}: HTTP ${res.status} ${body}`);
      }
      const json = (await res.json()) as VerboseJson;
      return {
        text: json.text ?? '',
        segments: json.segments?.map((s) => ({
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(s.end * 1000),
          text: s.text,
        })),
      };
    },
  };
}
