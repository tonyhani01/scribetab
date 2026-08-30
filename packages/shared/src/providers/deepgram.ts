import { MAX_KEYTERMS } from '../vocab.js';
import type {
  ProviderConfig,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from '../types.js';

interface DeepgramResponse {
  results?: {
    channels?: { alternatives?: { transcript?: string }[] }[];
    utterances?: { start: number; end: number; transcript: string }[];
  };
}

const TIMEOUT_MS = 120_000;

export const deepgramProvider: TranscriptionProvider = {
  id: 'deepgram',
  async transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult> {
    if (!cfg.apiKey) throw new Error('deepgram: apiKey is required');
    const base = (cfg.baseUrl ?? 'https://api.deepgram.com').replace(/\/+$/, '');
    const params = new URLSearchParams({
      model: cfg.model ?? 'nova-2',
      smart_format: 'true',
      utterances: 'true',
    });
    if (req.language) params.set('language', req.language);
    // Deepgram's vocabulary hook: one keyterm param per term, order preserved.
    for (const term of (cfg.vocabHints ?? []).map((t) => t.trim()).filter(Boolean).slice(0, MAX_KEYTERMS)) {
      params.append('keyterm', term);
    }

    const res = await fetch(`${base}/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${cfg.apiKey}`, 'Content-Type': req.mimeType },
      body: req.audio,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`deepgram: HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as DeepgramResponse;
    return {
      text: json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '',
      segments: json.results?.utterances?.map((u) => ({
        startMs: Math.round(u.start * 1000),
        endMs: Math.round(u.end * 1000),
        text: u.transcript,
      })),
    };
  },
};
