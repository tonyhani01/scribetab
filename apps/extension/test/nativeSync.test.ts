import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { muxOggOpus, remuxOggOpusChunks, type MeetingSession } from '@scribetab/shared';
import { putChunk } from '../utils/chunkStore';
import { closeDb } from '../utils/db';
import {
  ACK_TIMEOUT_MS,
  isHostForbiddenError,
  isHostMissingError,
  MAX_AUDIO_CHUNK,
  MAX_OGG_SYNC_SLICE,
  splitSyncAudio,
  syncSessionToHost,
} from '../utils/nativeSync';
import { putSegments } from '../utils/segmentStore';
import { createSession } from '../utils/sessionStore';

const session: MeetingSession = {
  id: 'sess-1',
  title: 'Sync Test',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'meet',
  status: 'complete',
};

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

type Posted = {
  type: string;
  index?: number;
  audio?: unknown;
  protocolVersion?: number;
  wavBase64?: string;
  dataBase64?: string;
  session?: unknown;
  segments?: Array<{ text?: string }>;
};

/** SILK 20 ms (TOC config 1, code 0) → 960 samples at 48 kHz. */
function oggBytes(serial: number): ArrayBuffer {
  return muxOggOpus([{ data: new Uint8Array([8, 0, 1, 2]), frameSamples48k: 960 }], {
    inputSampleRate: 16_000,
    serial,
  });
}

function mockPort(opts: { autoAck?: boolean; followUpError?: string } = {}) {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: Posted[] = [];
  const port = {
    posted,
    postMessage(msg: Posted) {
      posted.push(msg);
      if (opts.autoAck !== false && msg.type === 'sync_end') {
        queueMicrotask(() => {
          for (const fn of messageListeners) fn({ ok: true, sessionId: session.id });
          queueMicrotask(() => {
            for (const fn of messageListeners) {
              fn({
                ok: true,
                sessionId: session.id,
                ...(opts.followUpError ? { error: opts.followUpError } : {}),
              });
            }
          });
        });
      }
    },
    disconnect() {
      // no-op
    },
    onMessage: {
      addListener(fn: (msg: unknown) => void) {
        messageListeners.push(fn);
      },
    },
    onDisconnect: {
      addListener(fn: () => void) {
        disconnectListeners.push(fn);
      },
    },
    fireDisconnect() {
      for (const fn of disconnectListeners) fn();
    },
  };
  return port;
}

describe('nativeSync classification', () => {
  it('does not treat forbidden as missing', () => {
    const forbidden = 'Access to the specified native messaging host is forbidden.';
    expect(isHostForbiddenError(forbidden)).toBe(true);
    expect(isHostMissingError(forbidden)).toBe(false);
    expect(isHostMissingError('Specified native messaging host not found.')).toBe(true);
  });
});

describe('syncSessionToHost', () => {
  const storage: Record<string, unknown> = {};
  let port: ReturnType<typeof mockPort>;
  let lastError: { message?: string } | undefined;

  beforeEach(async () => {
    for (const k of Object.keys(storage)) delete storage[k];
    port = mockPort();
    lastError = undefined;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => {
            if (key === 'settings') {
              return {
                settings: {
                  providerId: '',
                  apiKey: '',
                  model: '',
                  language: '',
                  baseUrl: '',
                  micEnabled: false,
                  retainAudio: true,
                  nativeHostEnabled: true,
                },
              };
            }
            return { [key]: storage[key] };
          },
          set: async (v: Record<string, unknown>) => {
            Object.assign(storage, v);
          },
        },
      },
      runtime: {
        get lastError() {
          return lastError;
        },
        connectNative: () => {
          if (lastError) {
            queueMicrotask(() => port.fireDisconnect());
          }
          return port;
        },
      },
    });
    await closeDb();
    await deleteDb();
    await createSession(session);
    await putSegments([
      {
        id: 'seg',
        sessionId: session.id,
        startMs: 0,
        endMs: 10,
        text: 'hi',
        source: 'audio',
      },
    ]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    await deleteDb();
  });

  it('opens the native port before posting and streams chunks in order', async () => {
    let connected = false;
    (chrome.runtime.connectNative as unknown as () => typeof port) = () => {
      connected = true;
      return port;
    };
    await putChunk({
      sessionId: session.id,
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(64),
      createdAt: 1,
    });
    await putChunk({
      sessionId: session.id,
      index: 1,
      sampleRate: 16000,
      startOffsetSamples: 32,
      wav: new ArrayBuffer(64),
      createdAt: 2,
    });

    const result = await syncSessionToHost(session);
    expect(connected).toBe(true);
    expect(result.state).toBe('ok');
    expect(port.posted.map((m) => m.type)).toEqual([
      'sync_begin',
      'sync_audio_chunk',
      'sync_audio_chunk',
      'sync_end',
    ]);
    expect(port.posted.filter((m) => m.type === 'sync_audio_chunk').map((m) => m.index)).toEqual([
      0, 1,
    ]);
    expect(port.posted[0]).toMatchObject({
      protocolVersion: 1,
      audio: { format: 'wav', sampleRate: 16000, totalChunks: 2 },
    });
    expect(port.posted[1]?.wavBase64).toEqual(expect.any(String));
    expect(port.posted[1]?.dataBase64).toBeUndefined();
  });

  it('classifies a missing host as missing', async () => {
    lastError = { message: 'Specified native messaging host not found.' };
    const result = await syncSessionToHost(session);
    expect(result.state).toBe('missing');
    expect(result.message).toMatch(/not found/i);
    expect(result.message ?? '').not.toMatch(/install the host/i);
  });

  it('classifies forbidden access as error, not missing', async () => {
    lastError = { message: 'Access to the specified native messaging host is forbidden.' };
    const result = await syncSessionToHost(session);
    expect(result.state).toBe('error');
    expect(isHostMissingError(result.message ?? '')).toBe(false);
    expect(result.message ?? '').not.toMatch(/install the host/i);
  });

  it('times out when the host never acks', async () => {
    port = mockPort({ autoAck: false });
    const result = await syncSessionToHost(session, { ackTimeoutMs: 30 });
    expect(result.state).toBe('error');
    expect(result.message).toMatch(/timed out/i);
    expect(ACK_TIMEOUT_MS).toBe(30_000);
  });

  it('sends protocol v2 with remuxed ogg slices and dataBase64', async () => {
    const c0 = oggBytes(1);
    const c1 = oggBytes(2);
    await putChunk({
      sessionId: session.id,
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: c0,
      format: 'ogg-opus',
      durationMs: 20,
      createdAt: 1,
    });
    await putChunk({
      sessionId: session.id,
      index: 1,
      sampleRate: 16000,
      startOffsetSamples: 960,
      wav: c1,
      format: 'ogg-opus',
      durationMs: 20,
      createdAt: 2,
    });
    const expected = remuxOggOpusChunks([c0, c1]);

    const result = await syncSessionToHost(session);
    expect(result.state).toBe('ok');
    expect(port.posted.map((m) => m.type)).toEqual(['sync_begin', 'sync_audio_chunk', 'sync_end']);
    expect(port.posted[0]).toMatchObject({
      protocolVersion: 2,
      audio: { format: 'ogg-opus', totalChunks: 1 },
    });
    expect(expected.byteLength).toBeLessThanOrEqual(MAX_OGG_SYNC_SLICE);
    const chunk = port.posted[1];
    expect(chunk?.wavBase64).toBeUndefined();
    expect(chunk?.dataBase64).toEqual(expect.any(String));
    expect(Buffer.from(chunk!.dataBase64!, 'base64').equals(Buffer.from(expected))).toBe(true);
  });

  it('skips audio and still syncs transcript when ogg remux fails', async () => {
    await putChunk({
      sessionId: session.id,
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(16),
      format: 'ogg-opus',
      durationMs: 20,
      createdAt: 1,
    });
    const result = await syncSessionToHost(session);
    expect(result.state).toBe('ok');
    expect(port.posted.map((m) => m.type)).toEqual(['sync_begin', 'sync_end']);
    expect(port.posted[0]?.audio).toBeUndefined();
    expect(port.posted[0]?.protocolVersion).toBe(1);
    expect(port.posted[0]?.session).toEqual(session);
    expect(port.posted[0]?.segments).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'hi' })]));
  });

  it('skips audio when ogg-opus and wav rows are mixed', async () => {
    await putChunk({
      sessionId: session.id,
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(64),
      createdAt: 1,
    });
    await putChunk({
      sessionId: session.id,
      index: 1,
      sampleRate: 16000,
      startOffsetSamples: 32,
      wav: oggBytes(1),
      format: 'ogg-opus',
      durationMs: 20,
      createdAt: 2,
    });
    const result = await syncSessionToHost(session);
    expect(result.state).toBe('ok');
    expect(port.posted.map((m) => m.type)).toEqual(['sync_begin', 'sync_end']);
    expect(port.posted[0]?.protocolVersion).toBe(1);
    expect(port.posted.find((m) => m.type === 'sync_begin')?.audio).toBeUndefined();
  });

  it('skips audio when a chunk exceeds 8 MiB', async () => {
    await putChunk({
      sessionId: session.id,
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(MAX_AUDIO_CHUNK + 1),
      createdAt: 1,
    });
    const result = await syncSessionToHost(session);
    expect(result.state).toBe('ok');
    expect(port.posted.map((m) => m.type)).toEqual(['sync_begin', 'sync_end']);
  });

  it('surfaces integration warnings without failing core sync', async () => {
    port = mockPort({ followUpError: 'Notion: 401' });
    const result = await syncSessionToHost(session);
    expect(result.state).toBe('ok');
    expect(result.warning).toBe('Notion: 401');
  });
});

describe('splitSyncAudio', () => {
  it('splits a remuxed buffer into ≤6 MiB pieces', () => {
    const slices = splitSyncAudio(new ArrayBuffer(MAX_OGG_SYNC_SLICE + 1));
    expect(slices).toHaveLength(2);
    expect(slices[0]!.byteLength).toBe(MAX_OGG_SYNC_SLICE);
    expect(slices[1]!.byteLength).toBe(1);
  });

  it('returns one slice for an exactly-MAX_OGG_SYNC_SLICE buffer', () => {
    const slices = splitSyncAudio(new ArrayBuffer(MAX_OGG_SYNC_SLICE));
    expect(slices).toHaveLength(1);
    expect(slices[0]!.byteLength).toBe(MAX_OGG_SYNC_SLICE);
  });

  it('returns no slices for an empty buffer', () => {
    expect(splitSyncAudio(new ArrayBuffer(0))).toEqual([]);
  });
});
