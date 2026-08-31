import { remuxOggOpusChunks, type GetUpcomingAck, type GetUpcomingMessage, type HostSyncAck, type HostSyncMessage, type MeetingSession, type UpcomingEvent } from '@scribetab/shared';
import { getChunk, listChunkIndexes } from './chunkStore';
import { getSegments } from './segmentStore';
import type { StoredSession } from './sessionStore';
import { getSettings } from './settings';

export const NATIVE_HOST_NAME = 'com.scribetab.host';
export const MAX_AUDIO_CHUNK = 8 * 1024 * 1024;
/** Pre-base64 slice size so encoded v2 payloads stay under the 8 MiB decoded cap. */
export const MAX_OGG_SYNC_SLICE = 6 * 1024 * 1024;
export const ACK_TIMEOUT_MS = 30_000;
export const INTEGRATION_FOLLOWUP_MS = 70_000;
/** The host caps its own calendar fetch at 5 s; allow for process startup on top. */
export const UPCOMING_ACK_TIMEOUT_MS = 10_000;
export const MAX_UPCOMING_EVENTS = 50;

export type NativeHostStatus = {
  state: 'idle' | 'ok' | 'missing' | 'error';
  message?: string;
  warning?: string;
};

export function isHostForbiddenError(message: string): boolean {
  return /Access to the specified native messaging host is forbidden/i.test(message);
}

export function isHostMissingError(message: string): boolean {
  if (isHostForbiddenError(message)) return false;
  return /not found|not installed|Specified native messaging host|native messaging host.*not registered/i.test(
    message,
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function splitSyncAudio(buf: ArrayBuffer, maxBytes = MAX_OGG_SYNC_SLICE): ArrayBuffer[] {
  const slices: ArrayBuffer[] = [];
  for (let offset = 0; offset < buf.byteLength; offset += maxBytes) {
    slices.push(buf.slice(offset, offset + maxBytes));
  }
  return slices;
}

function classifyDisconnect(message: string): NativeHostStatus {
  if (isHostMissingError(message)) return { state: 'missing', message };
  return { state: 'error', message };
}

export async function persistHostStatus(status: NativeHostStatus): Promise<void> {
  await chrome.storage.local.set({ nativeHostStatus: status });
}

type NativePort = {
  postMessage: (msg: HostSyncMessage) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (msg: HostSyncAck) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
};

/**
 * Stream HostSyncMessage over connectNative. connectNative is opened first so
 * the service worker stays alive while IndexedDB is read one chunk at a time.
 */
export async function syncSessionToHost(
  session: MeetingSession,
  opts: { ackTimeoutMs?: number; integrationFollowupMs?: number } = {},
): Promise<NativeHostStatus> {
  const settings = await getSettings();
  if (!settings.nativeHostEnabled) {
    return { state: 'idle', message: 'Native host sync is disabled' };
  }
  if (session.status !== 'complete') {
    return { state: 'idle', message: 'Session is not complete' };
  }

  const ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  let port: NativePort;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME) as unknown as NativePort;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return classifyDisconnect(message);
  }

  return streamToPort(port, session, settings.retainAudio, ackTimeoutMs, opts.integrationFollowupMs);
}

async function streamToPort(
  port: NativePort,
  session: MeetingSession,
  retainAudio: boolean,
  ackTimeoutMs: number,
  integrationFollowupMs = INTEGRATION_FOLLOWUP_MS,
): Promise<NativeHostStatus> {
  let settled = false;
  let coreAck: HostSyncAck | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (status: NativeHostStatus): NativeHostStatus => {
    if (settled) return status;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      port.disconnect();
    } catch {
      // already disconnected
    }
    return status;
  };

  return new Promise((resolve) => {
    const finish = (status: NativeHostStatus) => resolve(settle(status));

    port.onMessage.addListener((msg: HostSyncAck) => {
      if (!msg?.ok) {
        finish({ state: 'error', message: msg?.error ?? 'Host sync failed' });
        return;
      }
      if (!coreAck) {
        coreAck = msg;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          finish({ state: 'ok', message: coreAck?.error });
        }, integrationFollowupMs);
        return;
      }
      finish({
        state: 'ok',
        message: coreAck.error,
        ...(msg.error ? { warning: msg.error } : {}),
      });
    });

    port.onDisconnect.addListener(() => {
      if (coreAck) {
        finish({ state: 'ok', message: coreAck.error });
        return;
      }
      const err = chrome.runtime.lastError?.message ?? 'Native host disconnected';
      finish(classifyDisconnect(err));
    });

    timer = setTimeout(() => {
      finish({ state: 'error', message: `Host ack timed out after ${ackTimeoutMs}ms` });
    }, ackTimeoutMs);

    void (async () => {
      try {
        const segments = await getSegments(session.id);
        const indexes = retainAudio ? await listChunkIndexes(session.id) : [];
        let includeAudio = indexes.length > 0;
        let sampleRate = 16000;
        let sawOgg = false;
        let sawWav = false;
        let oggSlices: ArrayBuffer[] = [];

        if (includeAudio) {
          for (const index of indexes) {
            const row = await getChunk(session.id, index);
            if (!row) {
              includeAudio = false;
              break;
            }
            if (row.format === 'ogg-opus') {
              sawOgg = true;
            } else {
              sawWav = true;
              if (row.wav.byteLength > MAX_AUDIO_CHUNK) {
                includeAudio = false;
                break;
              }
            }
            if (index === indexes[0]) sampleRate = row.sampleRate;
          }
          if (includeAudio && sawOgg && sawWav) includeAudio = false;
        }

        if (includeAudio && sawOgg) {
          const bufs: ArrayBuffer[] = [];
          for (const index of indexes) {
            const row = await getChunk(session.id, index);
            if (!row) {
              includeAudio = false;
              break;
            }
            bufs.push(row.wav);
          }
          if (includeAudio) {
            try {
              oggSlices = splitSyncAudio(remuxOggOpusChunks(bufs));
            } catch {
              includeAudio = false;
            }
          }
        }

        const summaryMarkdown = (session as StoredSession).summaryMarkdown?.trim();
        const oggAudio = includeAudio && sawOgg;
        const begin: HostSyncMessage = {
          type: 'sync_begin',
          protocolVersion: oggAudio ? 2 : 1,
          session,
          segments,
          ...(summaryMarkdown ? { summaryMarkdown } : {}),
          ...(includeAudio
            ? oggAudio
              ? { audio: { format: 'ogg-opus' as const, totalChunks: oggSlices.length } }
              : { audio: { format: 'wav' as const, sampleRate, totalChunks: indexes.length } }
            : {}),
        };
        port.postMessage(begin);

        if (includeAudio && oggAudio) {
          for (let index = 0; index < oggSlices.length; index++) {
            port.postMessage({
              type: 'sync_audio_chunk',
              sessionId: session.id,
              index,
              dataBase64: arrayBufferToBase64(oggSlices[index]!),
            });
          }
        } else if (includeAudio) {
          for (const index of indexes) {
            const row = await getChunk(session.id, index);
            if (!row || row.wav.byteLength > MAX_AUDIO_CHUNK) {
              includeAudio = false;
              break;
            }
            const wavBase64 = arrayBufferToBase64(row.wav);
            port.postMessage({
              type: 'sync_audio_chunk',
              sessionId: session.id,
              index,
              wavBase64,
            });
          }
        }

        port.postMessage({ type: 'sync_end', sessionId: session.id });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        finish(classifyDisconnect(message));
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Upcoming calendar events (read-only, host-mediated; see native-host README)
// ---------------------------------------------------------------------------

type UpcomingPort = {
  postMessage: (msg: GetUpcomingMessage) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (msg: GetUpcomingAck) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
};

function normalizeUpcomingEvents(raw: unknown): UpcomingEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: UpcomingEvent[] = [];
  for (const item of raw) {
    if (out.length >= MAX_UPCOMING_EVENTS) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.title !== 'string' || !Number.isFinite(rec.startMs) || !Number.isFinite(rec.endMs)) {
      continue;
    }
    const startMs = Math.trunc(rec.startMs as number);
    const endMs = Math.max(startMs, Math.trunc(rec.endMs as number));
    const title = rec.title.trim().slice(0, 200);
    if (title) out.push({ title, startMs, endMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The event overlapping `nowMs ± skewMs`, preferring the soonest start and then the
 * longest duration (a booked room block loses to the narrower meeting inside it).
 */
export function matchUpcomingEvent<T extends UpcomingEvent>(
  events: T[],
  nowMs: number,
  skewMs: number,
): T | null {
  const matches = events
    .filter((e) => e.startMs <= nowMs + skewMs && e.endMs >= nowMs - skewMs)
    .sort((a, b) => a.startMs - b.startMs || b.endMs - b.startMs - (a.endMs - a.startMs));
  return matches[0] ?? null;
}

/**
 * Ask the native host for the user's configured calendar. One `get_upcoming` message on
 * a short-lived connectNative port, resolved on the first ack.
 *
 * Best-effort by contract: host disabled, missing, slow, or malformed all yield `[]`,
 * and this never rejects — callers run it beside capture start.
 */
export async function getUpcomingEvents(
  opts: { ackTimeoutMs?: number } = {},
): Promise<UpcomingEvent[]> {
  let port: UpcomingPort;
  try {
    const settings = await getSettings();
    if (!settings.nativeHostEnabled) return [];
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME) as unknown as UpcomingPort;
  } catch {
    return [];
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (events: UpcomingEvent[]) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
      resolve(events);
    };

    port.onMessage.addListener((msg: GetUpcomingAck) => {
      settle(msg?.ok ? normalizeUpcomingEvents(msg.events) : []);
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consume "host not found" so it is not reported
      settle([]);
    });

    timer = setTimeout(() => settle([]), opts.ackTimeoutMs ?? UPCOMING_ACK_TIMEOUT_MS);

    try {
      port.postMessage({ type: 'get_upcoming', protocolVersion: 1 });
    } catch {
      settle([]);
    }
  });
}
