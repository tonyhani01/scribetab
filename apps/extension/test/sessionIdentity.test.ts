import { describe, expect, it } from 'vitest';
import {
  bootExceptId,
  bootShouldIdle,
  isLiveSession,
  offscreenStopApplies,
  statusFromCaptureEnded,
  statusFromOffscreenAck,
} from '../utils/sessionIdentity';

describe('isLiveSession', () => {
  it('only treats an ended event as live when ids match', () => {
    expect(isLiveSession('a', 'a')).toBe(true);
    expect(isLiveSession('a', 'b')).toBe(false);
    expect(isLiveSession('a', undefined)).toBe(false);
  });
});

describe('offscreenStopApplies', () => {
  it('force-stops when sessionId is omitted and ignores a mismatched live session', () => {
    expect(offscreenStopApplies(undefined, 'live')).toBe(true);
    expect(offscreenStopApplies('live', 'live')).toBe(true);
    expect(offscreenStopApplies('stale', 'live')).toBe(false);
  });
});

describe('offscreen health status', () => {
  it('marks a null/unreachable probe as failed, not complete', () => {
    expect(statusFromOffscreenAck(null)).toBe('failed');
    expect(statusFromOffscreenAck({ ok: false })).toBe('failed');
    expect(statusFromOffscreenAck({ ok: true })).toBe('complete');
  });

  it('marks CAPTURE_ENDED with an error (including processor-error) as failed', () => {
    expect(statusFromCaptureEnded('processor-error')).toBe('failed');
    expect(statusFromCaptureEnded(undefined)).toBe('complete');
  });
});

describe('boot reconciliation', () => {
  it('idles starting/stopping/recording unless the offscreen doc is still live', () => {
    expect(bootShouldIdle('starting', false)).toBe(true);
    expect(bootShouldIdle('recording', false)).toBe(true);
    expect(bootShouldIdle('recording', true)).toBe(false);
    expect(bootShouldIdle('idle', false)).toBe(false);
  });

  it('never excepts a session unless recording is live in the offscreen doc', () => {
    expect(bootExceptId('recording', 'live', true)).toBe('live');
    expect(bootExceptId('recording', 'stale', false)).toBeUndefined();
    expect(bootExceptId('starting', 'just-created', false)).toBeUndefined();
  });
});
