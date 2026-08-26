export type CaptureState = 'idle' | 'starting' | 'recording' | 'stopping';

/** Messages handled by the service worker (from popup or offscreen). */
export type ToBackground =
  | { target: 'background'; type: 'START_CAPTURE' }
  | { target: 'background'; type: 'STOP_CAPTURE' }
  | { target: 'background'; type: 'CHUNK_SAVED'; count: number }      // offscreen → SW
  | { target: 'background'; type: 'CAPTURE_ENDED'; reason: string };  // offscreen → SW

/** Messages handled by the offscreen document (from the service worker only). */
export type ToOffscreen =
  | { target: 'offscreen'; type: 'OFFSCREEN_START'; streamId: string }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP' };

export interface Ack {
  ok: boolean;
  error?: string;
}
