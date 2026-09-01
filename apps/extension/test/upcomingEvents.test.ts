import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpcomingEvent } from '@scribetab/shared';
import {
  getUpcomingEvents,
  matchUpcomingEvent,
  MAX_UPCOMING_EVENTS,
  UPCOMING_ACK_TIMEOUT_MS,
} from '../utils/nativeSync';
import { SETTINGS_STORAGE_KEY } from '../utils/settings';

const startMs = Date.parse('2026-09-01T12:00:00.000Z');
const events: UpcomingEvent[] = [
  { title: 'Standup', startMs, endMs: startMs + 15 * 60 * 1000 },
];

type Listener = (msg: unknown) => void;

function mockPort(opts: { autoAck?: boolean; ack?: unknown } = {}) {
  const messageListeners: Listener[] = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const port = {
    posted,
    postMessage(msg: Record<string, unknown>) {
      posted.push(msg);
      if (opts.autoAck !== false) {
        queueMicrotask(() => port.fireMessage(opts.ack ?? { ok: true, events }));
      }
    },
    disconnect: () => {},
    onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    fireMessage(msg: unknown) {
      for (const fn of [...messageListeners]) fn(msg);
    },
    fireDisconnect() {
      for (const fn of [...disconnectListeners]) fn();
    },
  };
  const disconnect = vi.fn(port.disconnect);
  return { ...port, disconnect };
}

function stubChrome(port: ReturnType<typeof mockPort>, nativeHostEnabled = true) {
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined,
      connectNative: () => port,
    },
    storage: {
      local: {
        get: async () => ({
          [SETTINGS_STORAGE_KEY]: { ...DEFAULTS_FOR_TEST, nativeHostEnabled },
        }),
      },
    },
  });
}

const DEFAULTS_FOR_TEST = {
  nativeHostEnabled: true,
};

describe('getUpcomingEvents', () => {
  let port: ReturnType<typeof mockPort>;

  beforeEach(() => {
    port = mockPort();
    stubChrome(port);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts get_upcoming v1 and resolves with the host events', async () => {
    expect(await getUpcomingEvents()).toEqual(events);
    expect(port.posted).toEqual([{ type: 'get_upcoming', protocolVersion: 1 }]);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('normalizes junk entries and sorts by start', async () => {
    port = mockPort({
      ack: {
        ok: true,
        events: [
          { title: '  Later  ', startMs: startMs + 1000, endMs: startMs + 2000 },
          { title: 'no numbers', startMs: 'x', endMs: 1 },
          { title: 'EndsBeforeStart', startMs: startMs, endMs: startMs - 5000 },
          null,
          'nope',
        ],
      },
    });
    stubChrome(port);
    expect(await getUpcomingEvents()).toEqual([
      { title: 'EndsBeforeStart', startMs, endMs: startMs },
      { title: 'Later', startMs: startMs + 1000, endMs: startMs + 2000 },
    ]);
  });

  it('caps the reply at MAX_UPCOMING_EVENTS', async () => {
    const many = Array.from({ length: MAX_UPCOMING_EVENTS + 20 }, (_, i) => ({
      title: `e${i}`,
      startMs: startMs + i,
      endMs: startMs + i + 1,
    }));
    port = mockPort({ ack: { ok: true, events: many } });
    stubChrome(port);
    expect(await getUpcomingEvents()).toHaveLength(MAX_UPCOMING_EVENTS);
  });

  it('returns [] when the host is disabled, missing, or silent', async () => {
    stubChrome(mockPort(), false);
    expect(await getUpcomingEvents()).toEqual([]);

    port = mockPort({ autoAck: false });
    stubChrome(port);
    const pending = getUpcomingEvents({ ackTimeoutMs: 20 });
    port.fireDisconnect();
    expect(await pending).toEqual([]);

    stubChrome(mockPort({ ack: { ok: false, events: [] } }));
    expect(await getUpcomingEvents()).toEqual([]);

    expect(UPCOMING_ACK_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('never rejects when connectNative throws', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: () => {
          throw new Error('Specified native messaging host not found.');
        },
      },
      storage: { local: { get: async () => ({}) } },
    });
    expect(await getUpcomingEvents()).toEqual([]);
  });
});

describe('matchUpcomingEvent', () => {
  const five = 5 * 60 * 1000;

  it('matches inside the ±5 minute window only', () => {
    const startingSoon: UpcomingEvent[] = [
      { title: 'soon', startMs: startMs + 4 * 60 * 1000, endMs: startMs + 34 * 60 * 1000 },
    ];
    expect(matchUpcomingEvent(startingSoon, startMs, five)?.title).toBe('soon');
    // 10 minutes early is outside the window; while it is live it is inside.
    expect(matchUpcomingEvent(startingSoon, startMs - 10 * 60 * 1000, five)).toBeNull();
    expect(matchUpcomingEvent(startingSoon, startMs + 20 * 60 * 1000, five)?.title).toBe('soon');
    // and 5 minutes after it ended it is gone again
    expect(matchUpcomingEvent(startingSoon, startMs + 40 * 60 * 1000, five)).toBeNull();
    expect(matchUpcomingEvent([], startMs, five)).toBeNull();
  });

  it('prefers the soonest start, then the longest event', () => {
    const list: UpcomingEvent[] = [
      { title: 'room-block', startMs, endMs: startMs + 120 * 60 * 1000 },
      { title: 'standup', startMs, endMs: startMs + 15 * 60 * 1000 },
      { title: 'later', startMs: startMs + 60 * 1000, endMs: startMs + 61 * 60 * 1000 },
    ];
    expect(matchUpcomingEvent(list, startMs + 60 * 1000, five)?.title).toBe('room-block');
    expect(matchUpcomingEvent(list, startMs + 30 * 60 * 1000, five)?.title).toBe('room-block');
  });
});
