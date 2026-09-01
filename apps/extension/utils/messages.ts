import type { HighlightKind, TranscriptSegment } from '@scribetab/shared';

export type CaptureState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/**
 * The offscreen doc owns a live audio graph for these states. `'paused'` keeps
 * the graph (and tab playback) running and only gates the PCM feed to the
 * chunker, so it counts as capturing everywhere a session must not be started,
 * torn down, or swept as stale.
 */
export function isCapturingState(state: unknown): state is 'recording' | 'paused' {
  return state === 'recording' || state === 'paused';
}

/** Any state between START and idle, including the transient starting/stopping legs. */
export function isLiveCaptureState(state: unknown): state is CaptureState {
  return (
    state === 'starting' ||
    state === 'recording' ||
    state === 'paused' ||
    state === 'stopping'
  );
}

/**
 * Capture state after a pause/resume request, or null when the request does not
 * apply to the current state (double pause, resume while idle, pause while the
 * `stopping` drain runs). Callers surface that as a plain error, never a state
 * change.
 */
export function captureStateAfterToggle(
  state: unknown,
  wantPaused: boolean,
): CaptureState | null {
  if (wantPaused) return state === 'recording' ? 'paused' : null;
  return state === 'paused' ? 'recording' : null;
}

/** Why live transcription is off. Null when STT (or captions-only) is usable. */
export type TranscriptionIssue = 'unconfigured' | 'missing-permission' | null;

/** What the offscreen doc needs to run transcription (it has no chrome.storage). */
export interface TranscriptionSettingsPayload {
  providerId: string;
  apiKey: string;
  model?: string;
  language?: string;
  baseUrl?: string;
  vocabHints?: string[];
  diarize?: boolean;   // ElevenLabs Scribe diarization toggle (default true)
  smartMode?: boolean; // Gemini Smart mode (no timestamps/diarization)
}

/** Messages handled by the service worker (from popup, offscreen, or Meet content script). */
export type ToBackground =
  | { target: 'background'; type: 'START_CAPTURE' }
  | { target: 'background'; type: 'STOP_CAPTURE' }
  | { target: 'background'; type: 'PAUSE_CAPTURE' } // gate the offscreen PCM feed, keep the graph
  | { target: 'background'; type: 'RESUME_CAPTURE' }
  | { target: 'background'; type: 'CHUNK_SAVED'; count: number; sessionId: string }      // offscreen → SW
  | { target: 'background'; type: 'SEGMENT_SAVED'; count: number; chunkIndex: number; sessionId: string }    // offscreen → SW (running total)
  | { target: 'background'; type: 'TRANSCRIPTION_ERROR'; message: string | null } // offscreen → SW (null clears)
  | { target: 'background'; type: 'MIC_STATUS'; status: 'active' | 'denied' | 'off' } // offscreen → SW
  | { target: 'background'; type: 'CAPTURE_ENDED'; sessionId: string; reason: string; error?: string }  // offscreen → SW
  | {
      target: 'background';
      type: 'AUDIO_STARTED';
      sessionId: string;
      startedAtMs: number; // wall-clock Date.now() when the worklet actually starts
    }
  | { target: 'background'; type: 'CAPTION_CAPTURE_QUERY' } // Meet content script → SW
  | {
      target: 'background';
      type: 'CAPTION_EVENT';
      speaker: string;
      text: string;
      timestampMs: number; // wall-clock Date.now() at caption start
      endMs?: number;      // wall-clock last mutation time for the block
    }
  | { target: 'background'; type: 'SYNC_ALL' }
  | {
      target: 'background';
      type: 'REGENERATE_SUMMARY';
      sessionId: string;
      templateId?: string;
    }
  | { target: 'background'; type: 'EXPORT_ACTIONS'; sessionId: string; itemIds: string[] }
  | {
      target: 'background';
      type: 'ADD_HIGHLIGHT';
      sessionId: string;
      label?: string;
      kind?: HighlightKind;
    }
  | { target: 'background'; type: 'RENAME_SPEAKER'; sessionId: string; from: string; to: string }
  | { target: 'background'; type: 'RENAME_SESSION'; sessionId: string; title: string }
  | { target: 'background'; type: 'ARCHIVE_SESSION'; sessionId: string }
  | { target: 'background'; type: 'RESTORE_SESSION'; sessionId: string }
  | { target: 'background'; type: 'EDIT_SEGMENT'; sessionId: string; segmentId: string; text: string }
  | { target: 'background'; type: 'IMPORT_TRANSCRIPT'; name: string; content: string }
  | {
      target: 'background';
      type: 'CHAT_ASK';
      sessionId: string;
      question: string;
      /** Prior Q/A turns from this panel only — in-memory, never persisted. */
      history: { q: string; a: string }[];
    }
  | { target: 'background'; type: 'LIBRARY_ASK'; question: string };

/** Broadcast to the Meet captions content script when tab capture starts/stops. */
export type ToMeetCaptions = {
  target: 'meet-captions';
  type: 'CAPTURE_ACTIVE';
  active: boolean;
};

/** Consent reminder injected into the meeting tab while capture is active. */
export type ToMeetConsent = {
  target: 'meet-consent';
  type: 'SHOW_CONSENT' | 'HIDE_CONSENT';
};

/** Messages handled by the offscreen document (from the service worker only). */
export type ToOffscreen =
  | {
      target: 'offscreen';
      type: 'OFFSCREEN_START';
      streamId: string;
      sessionId: string;
      transcription: TranscriptionSettingsPayload | null; // null = record only, no STT configured
      micEnabled: boolean;
      /** When set, segment text is redacted before IndexedDB write. */
      redaction: { extraTerms: string[] } | null;
      /** Local correction rules, applied after redaction and before IndexedDB write. */
      replacements: [string, string][];
    }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP'; sessionId?: string }
  | { target: 'offscreen'; type: 'OFFSCREEN_PAUSE' }
  | { target: 'offscreen'; type: 'OFFSCREEN_RESUME' };

/** Broadcast to the side panel (from the offscreen document or service worker). */
export type ToSidePanel =
  | {
      target: 'sidepanel';
      type: 'SEGMENTS_ADDED';
      sessionId: string;
      segments: TranscriptSegment[];
      chunkIndex?: number;
    }
  | {
      target: 'sidepanel';
      type: 'CHUNK_TRANSCRIBING';
      sessionId: string;
      chunkIndex: number;
      startMs: number;
      durationMs: number;
    }
  | {
      target: 'sidepanel';
      type: 'SEGMENTS_UPDATED';
      sessionId: string;
      segments: TranscriptSegment[];
    }
  | {
      target: 'sidepanel';
      type: 'SUMMARY_DELTA';
      sessionId: string;
      /** crypto.randomUUID() per runFinalizeIntelligence invocation. */
      runId: string;
      phase: 'summary' | 'actions';
      /** Accumulated text so far for this phase (not the increment). */
      text: string;
    }
  | {
      target: 'sidepanel';
      type: 'HIGHLIGHT_ADDED';
      sessionId: string;
    };

export interface Ack {
  ok: boolean;
  error?: string;
  warning?: string;
  hostMissing?: boolean;
  captured?: boolean;
}

/** `error: 'needs-permission'` means the LLM origin was never granted. */
export interface ChatAskAck {
  ok: boolean;
  answer?: string;
  error?: string;
}

/** A meeting whose context was included in a LIBRARY_ASK prompt. */
export interface LibraryAskSource {
  sessionId: string;
  title: string;
}

/** `error: 'needs-permission'` means the LLM origin was never granted. */
export interface LibraryAskAck {
  ok: boolean;
  answer?: string;
  sources?: LibraryAskSource[];
  error?: string;
}

export type ImportTranscriptAck =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };
