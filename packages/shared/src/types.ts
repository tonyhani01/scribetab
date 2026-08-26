export interface MeetingSession {
  id: string;                // crypto.randomUUID()
  title: string;
  startedAt: string;         // ISO 8601
  endedAt?: string;
  platform: 'meet' | 'teams' | 'zoom' | 'youtube' | 'other';
  tabUrl?: string;
  status: 'recording' | 'complete' | 'failed';
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

export interface TranscribeRequest {
  audio: ArrayBuffer;        // encoded audio (WAV in v1)
  mimeType: string;          // 'audio/wav'
  language?: string;         // BCP-47 hint
}

export interface TranscribeResult {
  text: string;
  segments?: { startMs: number; endMs: number; text: string }[];
  costUsd?: number;          // provider-computed estimate, feeds cost meter
}

export interface TranscriptionProvider {
  readonly id: string;       // 'openai' | 'groq' | 'deepgram' | 'mistral' | 'custom'
  transcribe(req: TranscribeRequest, cfg: ProviderConfig): Promise<TranscribeResult>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;          // set for 'custom' → localhost servers = local models
  model?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(messages: ChatMessage[], cfg: ProviderConfig): Promise<string>;
}

export type HostSyncMessage =
  | {
      type: 'sync_begin';
      protocolVersion: 1;
      session: MeetingSession;
      segments: TranscriptSegment[];
      summaryMarkdown?: string;
      audio?: { format: 'wav'; sampleRate: number; totalChunks: number }; // present only when retention enabled
    }
  | { type: 'sync_audio_chunk'; sessionId: string; index: number; wavBase64: string } // ≤ 8 MiB decoded per chunk
  | { type: 'sync_end'; sessionId: string };

export interface HostSyncAck {
  ok: boolean;
  sessionId: string;
  error?: string;            // host replies after sync_end (and on any failure)
}
