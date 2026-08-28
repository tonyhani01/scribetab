import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportActionsAck, ExportActionsMessage } from '@scribetab/shared';
import { closeDb } from '../utils/db';
import { isHostMissingError } from '../utils/nativeSync';
import { createSession, getSession, updateSession } from '../utils/sessionStore';
import {
  EXPORT_ACK_TIMEOUT_MS,
  exportActionsViaHost,
  exportSelectedActionItems,
  nextSelection,
} from '../utils/actionExport';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

type Posted = ExportActionsMessage;

function mockPort(opts: { autoAck?: boolean; ack?: ExportActionsAck } = {}) {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: Posted[] = [];
  const port = {
    posted,
    postMessage(msg: Posted) {
      posted.push(msg);
      if (opts.autoAck !== false) {
        const ack =
          opts.ack ??
          ({
            ok: true,
            sessionId: msg.sessionId,
            results: (msg.items ?? []).map((i) => ({ id: i.id, ok: true })),
          } satisfies ExportActionsAck);
        queueMicrotask(() => {
          for (const fn of messageListeners) fn(ack);
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
    fireMessage(msg: unknown) {
      for (const fn of messageListeners) fn(msg);
    },
  };
  return port;
}

const items = [
  { id: 'a1', text: 'Send the notes', owner: 'Bo' },
  { id: 'a2', text: 'Book the room' },
];

describe('nextSelection', () => {
  const prev = new Set(['a1', 'a2']);

  it('keeps the selection on a transport-level failure', () => {
    const ack: ExportActionsAck = {
      ok: false,
      sessionId: 's',
      error: 'host missing',
      results: [],
    };
    const out = nextSelection(prev, ack);
    expect(out.sel).toBe(prev);
    expect(out.retryCount).toBeNull();
    expect(out.transportError).toBe('host missing');
  });

  it('falls back to Export failed when the transport ack has no error', () => {
    const out = nextSelection(prev, { ok: false, sessionId: 's', results: [] });
    expect(out.sel).toBe(prev);
    expect(out.retryCount).toBeNull();
    expect(out.transportError).toBe('Export failed');
  });

  it('clears the selection when every result is ok', () => {
    const out = nextSelection(prev, {
      ok: true,
      sessionId: 's',
      results: [
        { id: 'a1', ok: true },
        { id: 'a2', ok: true },
      ],
    });
    expect([...out.sel]).toEqual([]);
    expect(out.retryCount).toBeNull();
    expect(out.transportError).toBeNull();
  });

  it('keeps only failed ids on a partial failure', () => {
    const out = nextSelection(prev, {
      ok: false,
      sessionId: 's',
      results: [
        { id: 'a1', ok: true },
        { id: 'a2', ok: false, error: '500' },
      ],
    });
    expect([...out.sel]).toEqual(['a2']);
    expect(out.retryCount).toBe(1);
    expect(out.transportError).toBeNull();
  });
});

describe('exportActionsViaHost', () => {
  let port: ReturnType<typeof mockPort>;
  let lastError: { message?: string } | undefined;

  beforeEach(() => {
    port = mockPort();
    lastError = undefined;
    vi.stubGlobal('chrome', {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts export_actions and resolves with the host ack', async () => {
    const ack = await exportActionsViaHost('sess-1', items);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]?.type).toBe('export_actions');
    expect(port.posted[0]?.protocolVersion).toBe(1);
    expect(port.posted[0]?.sessionId).toBe('sess-1');
    expect(port.posted[0]?.items).toEqual(items);
    expect(ack.ok).toBe(true);
    expect(ack.results).toEqual([
      { id: 'a1', ok: true },
      { id: 'a2', ok: true },
    ]);
  });

  it('classifies disconnect-before-ack as a host-missing failure', async () => {
    port = mockPort({ autoAck: false });
    lastError = { message: 'Specified native messaging host not found.' };
    const ack = await exportActionsViaHost('sess-1', items);
    expect(ack.ok).toBe(false);
    expect(ack.results).toEqual([]);
    expect(isHostMissingError(ack.error ?? '')).toBe(true);
  });

  it('times out when the host never acks', async () => {
    port = mockPort({ autoAck: false });
    const ack = await exportActionsViaHost('sess-1', items, { ackTimeoutMs: 30 });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/timed out/i);
    expect(ack.results).toEqual([]);
    expect(EXPORT_ACK_TIMEOUT_MS).toBe(90_000);
  });
});

describe('EXPORT_ACTIONS handler contract', () => {
  let port: ReturnType<typeof mockPort>;

  beforeEach(async () => {
    port = mockPort();
    vi.stubGlobal('chrome', {
      runtime: {
        get lastError() {
          return undefined;
        },
        connectNative: () => port,
      },
    });
    await closeDb();
    await deleteDb();
    await createSession({
      id: 'sess-exp',
      title: 'Export Test',
      startedAt: '2026-08-28T10:00:00.000Z',
      platform: 'meet',
      status: 'complete',
      summary: {
        version: 1,
        narrative: 'Recap.',
        actionItems: [
          { id: 'a1', text: 'One' },
          { id: 'a2', text: 'Two' },
          { id: 'a3', text: 'Three' },
        ],
        decisions: [],
        usefulInfo: [],
        generatedAt: '2026-08-28T10:01:00.000Z',
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    await deleteDb();
  });

  it('posts only the selected items and caches successful exports', async () => {
    const ack = await exportSelectedActionItems('sess-exp', ['a1', 'a3']);
    expect(ack.ok).toBe(true);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]?.items.map((i) => i.id)).toEqual(['a1', 'a3']);
    expect(port.posted[0]?.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'a2' })]),
    );
    const row = await getSession('sess-exp');
    expect(row?.actionExports?.a1).toEqual({
      destination: 'notion',
      at: expect.any(String),
    });
    expect(row?.actionExports?.a3).toEqual({
      destination: 'notion',
      at: expect.any(String),
    });
    expect(row?.actionExports?.a2).toBeUndefined();
  });

  it('merges actionExports onto a re-read session after ack', async () => {
    port = mockPort({ autoAck: false });
    vi.stubGlobal('chrome', {
      runtime: {
        get lastError() {
          return undefined;
        },
        connectNative: () => port,
      },
    });
    const pending = exportSelectedActionItems('sess-exp', ['a1', 'a3']);
    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    await updateSession('sess-exp', {
      actionExports: {
        concurrent: { destination: 'notion', at: '2026-08-28T09:00:00.000Z' },
      },
    });
    port.fireMessage({
      ok: true,
      sessionId: 'sess-exp',
      results: [
        { id: 'a1', ok: true },
        { id: 'a3', ok: true },
      ],
    } satisfies ExportActionsAck);
    const ack = await pending;
    expect(ack.ok).toBe(true);
    const row = await getSession('sess-exp');
    expect(row?.actionExports?.concurrent).toEqual({
      destination: 'notion',
      at: '2026-08-28T09:00:00.000Z',
    });
    expect(row?.actionExports?.a1).toEqual({
      destination: 'notion',
      at: expect.any(String),
    });
    expect(row?.actionExports?.a3).toEqual({
      destination: 'notion',
      at: expect.any(String),
    });
  });

  it('does not patch the cache when no items match', async () => {
    const ack = await exportSelectedActionItems('sess-exp', ['missing']);
    expect(ack).toEqual({
      ok: false,
      sessionId: 'sess-exp',
      error: 'No matching action items',
      results: [],
    });
    expect(port.posted).toHaveLength(0);
    const row = await getSession('sess-exp');
    expect(row?.actionExports).toBeUndefined();
  });
});
