import type { TranscriptSegment } from '@scribetab/shared';

export type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping';

/** Why live transcription is off. Null when STT (or captions-only) is usable. */
export type TranscriptionIssue = 'unconfigured' | 'missing-permission' | null;

/** What the offscreen doc needs to run transcription (it has no chrome.storage). */
export interface TranscriptionSettingsPayload {
  providerId: string;
  apiKey: string;
  model?: string;
  language?: string;
  baseUrl?: string;
}

/** Messages handled by the service worker (from popup, offscreen, or Meet content script). */
export type ToBackground =
  | { target: 'background'; type: 'START_CAPTURE' }
  | { target: 'background'; type: 'STOP_CAPTURE' }
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
  | { target: 'background'; type: 'REGENERATE_SUMMARY'; sessionId: string };

/** Broadcast to the Meet captions content script when tab capture starts/stops. */
export type ToMeetCaptions = {
  target: 'meet-captions';
  type: 'CAPTURE_ACTIVE';
  active: boolean;
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
    }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP'; sessionId?: string };

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
    };

export interface Ack {
  ok: boolean;
  error?: string;
  warning?: string;
  hostMissing?: boolean;
  captured?: boolean;
}
