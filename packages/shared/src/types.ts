export interface MeetingSession {
  id: string;                // crypto.randomUUID()
  title: string;
  startedAt: string;         // ISO 8601
  endedAt?: string;
  platform: 'meet' | 'teams' | 'zoom' | 'youtube' | 'other';
  tabUrl?: string;
  status: 'recording' | 'complete' | 'failed';
  /** Manual speaker renames, original → display name. Extension-side convention. */
  speakerNames?: Record<string, string>;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  startMs: number;           // ms since session start — ALWAYS session-relative,
  endMs: number;             // never chunk-relative; producers must add chunk offsets
  text: string;
  speaker?: string;          // from caption fusion (Phase 6)
  source: 'audio' | 'captions';
}

/** What a flagged moment means; rendered as an emoji prefix in lists/exports. */
export type HighlightKind = 'highlight' | 'action' | 'decision' | 'question' | 'note';

/** A moment the user flagged mid-call (hotkey or side-panel button). */
export interface HighlightMoment {
  id: string;                // crypto.randomUUID()
  sessionId: string;
  startMs: number;           // session-relative
  label?: string;            // optional short note typed later (≤ 200 chars)
  kind?: HighlightKind;      // rows from before kinds existed are 'highlight'
  createdAt: string;         // ISO 8601 wall clock
}

export interface TranscribeRequest {
  audio: ArrayBuffer;        // encoded audio (WAV in v1)
  mimeType: string;          // 'audio/wav'
  language?: string;         // BCP-47 hint
}

export interface TranscribeResult {
  text: string;
  segments?: { startMs: number; endMs: number; text: string; speaker?: string }[];
  costUsd?: number;          // provider-computed estimate, feeds cost meter
}

export interface TranscriptionProvider {
  readonly id: string;       // 'openai' | 'groq' | 'deepgram' | 'mistral' | 'openrouter' | 'google' | 'elevenlabs' | 'custom'
  transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;          // set for 'custom' → localhost servers = local models
  model?: string;
  /**
   * Custom-vocabulary terms the user wants recognised (Whisper-style `prompt`
   * field, Deepgram `keyterm` params). Settings-derived, so it travels with the
   * config rather than the per-chunk audio request. Providers without hint
   * support ignore it — the ingest-side replacement dictionary still applies.
   */
  vocabHints?: string[];
  /**
   * Speaker diarization request flag (default true). Honored by providers whose
   * API exposes a toggle (ElevenLabs Scribe `diarize`); others always diarize
   * or never do, and ignore it.
   */
  diarize?: boolean;
  /**
   * Gemini only: use Smart mode (clean, formatted text) instead of verbatim.
   * Smart mode returns no word timestamps or diarization, so segments collapse
   * to one per chunk. Ignored by other providers.
   */
  smartMode?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(messages: ChatMessage[], cfg: ProviderConfig): Promise<string>;
  /** Incremental tokens via `onDelta`; resolves to the full assembled text. */
  stream?(
    messages: ChatMessage[],
    cfg: ProviderConfig,
    onDelta: (text: string) => void,
  ): Promise<string>;
}

export interface ActionItem {
  id: string;               // crypto.randomUUID(); assigned client-side
  text: string;
  owner?: string;
  due?: string;             // verbatim phrase, never an inferred date
}

/** A named section of the meeting, anchored to a transcript timestamp. */
export interface SummaryChapter {
  title: string;
  startMs: number;           // session-relative
}

export interface SessionSummary {
  version: 1;
  narrative: string;        // markdown paragraphs
  actionItems: ActionItem[];
  decisions: string[];
  usefulInfo: string[];
  /** Optional: absent on summaries generated before chapters existed. */
  chapters?: SummaryChapter[];
  generatedAt: string;      // ISO 8601
  model?: string;
  degraded?: true;          // set when JSON extraction failed (raw text fallback)
}

export type HostSyncAudio =
  | { format: 'wav'; sampleRate: number; totalChunks: number }
  | { format: 'ogg-opus'; totalChunks: number }; // ogg-opus is valid only with protocolVersion 2

export type HostSyncMessage =
  | {
      type: 'sync_begin';
      protocolVersion: 1 | 2;
      session: MeetingSession;
      segments: TranscriptSegment[];
      summaryMarkdown?: string;
      audio?: HostSyncAudio; // present only when retention enabled
    }
  | {
      type: 'sync_audio_chunk';
      sessionId: string;
      index: number;
      wavBase64?: string; // v1/wav
      dataBase64?: string; // v2/ogg-opus
    } // exactly one payload field; ≤ 8 MiB decoded
  | { type: 'sync_end'; sessionId: string };

export interface HostSyncAck {
  ok: boolean;
  sessionId: string;
  error?: string;            // host replies after sync_end (and on any failure)
}

export type ExportActionsMessage = {
  type: 'export_actions';
  protocolVersion: 1;
  sessionId: string;
  items: ActionItem[];
};

export interface ExportActionsAck {
  ok: boolean;
  sessionId: string;
  error?: string;                 // transport/config-level failure
  results: { id: string; ok: boolean; error?: string }[];
  pageUrl?: string;
}

export interface UpcomingEvent {
  title: string;
  startMs: number;
  endMs: number;
}

export type GetUpcomingMessage = {
  type: 'get_upcoming';
  protocolVersion: 1;
};

export interface GetUpcomingAck {
  ok: boolean;
  events: UpcomingEvent[];
}

export type HostMessage = HostSyncMessage | ExportActionsMessage | GetUpcomingMessage;
