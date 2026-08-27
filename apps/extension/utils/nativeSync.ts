import type { HostSyncAck, HostSyncMessage, MeetingSession } from '@scribetab/shared';
import { getChunksForSession } from './chunkStore';
import { getSegments } from './segmentStore';
import { getSettings } from './settings';

export const NATIVE_HOST_NAME = 'com.scribetab.host';
const MAX_AUDIO_CHUNK = 8 * 1024 * 1024;

export type NativeHostStatus = {
  state: 'idle' | 'ok' | 'missing' | 'error';
  message?: string;
};

export function isHostMissingError(message: string): boolean {
  return /not found|not installed|Specified native messaging host|native messaging host.*not registered|Access to the specified native messaging host is forbidden/i.test(
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

export async function persistHostStatus(status: NativeHostStatus): Promise<void> {
  await chrome.storage.local.set({ nativeHostStatus: status });
}

/**
 * Stream HostSyncMessage over connectNative. A missing host is a hint, never retried in a loop.
 */
export async function syncSessionToHost(session: MeetingSession): Promise<NativeHostStatus> {
  const settings = await getSettings();
  if (!settings.nativeHostEnabled) {
    return { state: 'idle', message: 'Native host sync is disabled' };
  }

  const segments = await getSegments(session.id);
  const chunks = settings.retainAudio ? await getChunksForSession(session.id) : [];
  for (const [i, chunk] of chunks.entries()) {
    if (chunk.wav.byteLength > MAX_AUDIO_CHUNK) {
      return { state: 'error', message: `Audio chunk ${i} exceeds 8 MiB` };
    }
  }

  const audioMessages: HostSyncMessage[] = chunks.map((chunk, index) => ({
    type: 'sync_audio_chunk',
    sessionId: session.id,
    index,
    wavBase64: arrayBufferToBase64(chunk.wav),
  }));

  const begin: HostSyncMessage = {
    type: 'sync_begin',
    protocolVersion: 1,
    session,
    segments,
    ...(audioMessages.length > 0
      ? { audio: { format: 'wav' as const, sampleRate: chunks[0]!.sampleRate, totalChunks: audioMessages.length } }
      : {}),
  };

  const sequence: HostSyncMessage[] = [
    begin,
    ...audioMessages,
    { type: 'sync_end', sessionId: session.id },
  ];

  return sendNativeSequence(sequence);
}

function sendNativeSequence(messages: HostSyncMessage[]): Promise<NativeHostStatus> {
  return new Promise((resolve) => {
    let settled = false;
    let port: chrome.runtime.Port;
    const settle = (status: NativeHostStatus) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
      resolve(status);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      resolve({ state: 'missing', message: e instanceof Error ? e.message : String(e) });
      return;
    }

    port.onMessage.addListener((msg: HostSyncAck) => {
      if (msg?.ok) settle({ state: 'ok' });
      else settle({ state: 'error', message: msg?.error ?? 'Host sync failed' });
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'Native host disconnected';
      if (isHostMissingError(err)) settle({ state: 'missing', message: err });
      else settle({ state: 'error', message: err });
    });

    try {
      for (const m of messages) port.postMessage(m);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      settle(isHostMissingError(message) ? { state: 'missing', message } : { state: 'error', message });
    }
  });
}
