import type { TranscriptSegment } from '@scribetab/shared';

export type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping';

/** What the offscreen doc needs to run transcription (it has no chrome.storage). */
export interface TranscriptionSettingsPayload {
  providerId: string;
  apiKey: string;
  model?: string;
  language?: string;
  baseUrl?: string;
}

/** Messages handled by the service worker (from popup or offscreen). */
export type ToBackground =
  | { target: 'background'; type: 'START_CAPTURE' }
  | { target: 'background'; type: 'STOP_CAPTURE' }
  | { target: 'background'; type: 'CHUNK_SAVED'; count: number }      // offscreen → SW
  | { target: 'background'; type: 'SEGMENT_SAVED'; count: number }    // offscreen → SW (running total)
  | { target: 'background'; type: 'MIC_STATUS'; status: 'active' | 'denied' | 'off' } // offscreen → SW
  | { target: 'background'; type: 'CAPTURE_ENDED'; sessionId: string; reason: string; error?: string }  // offscreen → SW
  | { target: 'background'; type: 'SYNC_ALL' };

/** Messages handled by the offscreen document (from the service worker only). */
export type ToOffscreen =
  | {
      target: 'offscreen';
      type: 'OFFSCREEN_START';
      streamId: string;
      sessionId: string;
      transcription: TranscriptionSettingsPayload | null; // null = record only, no STT configured
      micEnabled: boolean;
    }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP'; sessionId?: string };

/** Broadcast to the side panel (from the offscreen document). */
export type ToSidePanel = {
  target: 'sidepanel';
  type: 'SEGMENTS_ADDED';
  sessionId: string;
  segments: TranscriptSegment[];
};

export interface Ack {
  ok: boolean;
  error?: string;
  hostMissing?: boolean;
}
