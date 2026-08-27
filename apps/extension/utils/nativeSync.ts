import type { HostSyncAck, HostSyncMessage, MeetingSession } from '@scribetab/shared';
import { getChunk, listChunkIndexes } from './chunkStore';
import { getSegments } from './segmentStore';
import type { StoredSession } from './sessionStore';
import { getSettings } from './settings';

export const NATIVE_HOST_NAME = 'com.scribetab.host';
export const MAX_AUDIO_CHUNK = 8 * 1024 * 1024;
export const ACK_TIMEOUT_MS = 30_000;
export const INTEGRATION_FOLLOWUP_MS = 70_000;

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

        if (includeAudio) {
          for (const index of indexes) {
            const row = await getChunk(session.id, index);
            // TODO: protocol v2 — ogg-opus cannot be sent as wav.
            if (!row || row.wav.byteLength > MAX_AUDIO_CHUNK || row.format === 'ogg-opus') {
              includeAudio = false;
              break;
            }
            if (index === indexes[0]) sampleRate = row.sampleRate;
          }
        }

        const summaryMarkdown = (session as StoredSession).summaryMarkdown?.trim();
        const begin: HostSyncMessage = {
          type: 'sync_begin',
          protocolVersion: 1,
          session,
          segments,
          ...(summaryMarkdown ? { summaryMarkdown } : {}),
          ...(includeAudio
            ? { audio: { format: 'wav' as const, sampleRate, totalChunks: indexes.length } }
            : {}),
        };
        port.postMessage(begin);

        if (includeAudio) {
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
