import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingSession } from '@scribetab/shared';
import { putChunk, sessionHasChunks } from '../utils/chunkStore';
import { closeDb } from '../utils/db';
import {
  enforceQuota,
  isOverTarget,
  isOverWarn,
  nextSessionToDropAudio,
  usageRatio,
} from '../utils/quota';
import { createSession } from '../utils/sessionStore';

const s = (over: Partial<MeetingSession>): MeetingSession => ({
  id: 'x',
  title: 't',
  startedAt: '2026-08-01T00:00:00.000Z',
  platform: 'other',
  status: 'complete',
  ...over,
});

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('quota policy', () => {
  it('treats missing quota as ratio 0', () => {
    expect(usageRatio(100, 0)).toBe(0);
  });

  it('warns above 80% and targets 70%', () => {
    expect(isOverWarn(0.8)).toBe(false);
    expect(isOverWarn(0.801)).toBe(true);
    expect(isOverTarget(0.7)).toBe(false);
    expect(isOverTarget(0.701)).toBe(true);
  });

  it('picks the oldest completed or failed session that still has audio', () => {
    const sessions = [
      s({ id: 'rec', status: 'recording', startedAt: '2026-01-01T00:00:00.000Z' }),
      s({ id: 'fail', status: 'failed', startedAt: '2026-01-02T00:00:00.000Z' }),
      s({ id: 'new', startedAt: '2026-08-01T00:00:00.000Z' }),
      s({ id: 'old', startedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const withAudio = new Set(['rec', 'fail', 'new', 'old']);
    expect(nextSessionToDropAudio(sessions, withAudio)?.id).toBe('fail');
  });

  it('skips completed sessions whose audio is already gone', () => {
    const sessions = [s({ id: 'empty', startedAt: '2026-01-01T00:00:00.000Z' })];
    expect(nextSessionToDropAudio(sessions, new Set())).toBeUndefined();
  });
});

describe('enforceQuota', () => {
  const storage: Record<string, unknown> = {};

  beforeEach(async () => {
    for (const k of Object.keys(storage)) delete storage[k];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          set: async (v: Record<string, unknown>) => {
            Object.assign(storage, v);
          },
        },
      },
    });
    await closeDb();
    await deleteDb();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    await deleteDb();
  });

  async function seed(id: string, startedAt: string, status: MeetingSession['status'] = 'complete') {
    await createSession(s({ id, startedAt, status }));
    await putChunk({
      sessionId: id,
      index: 0,
      sampleRate: 16000,
      startOffsetSamples: 0,
      wav: new ArrayBuffer(8),
      createdAt: 1,
    });
  }

  it('deletes audio rows of the oldest droppable session', async () => {
    await seed('old', '2026-01-01T00:00:00.000Z');
    await seed('new', '2026-08-01T00:00:00.000Z');
    let usage = 90;
    const report = await enforceQuota(async () => ({ usage, quota: 100 }));
    // Constant estimate does not drop — loop must stop after one deletion.
    expect(report.deletedSessionIds).toEqual(['old']);
    expect(await sessionHasChunks('old')).toBe(false);
    expect(await sessionHasChunks('new')).toBe(true);
  });

  it('stops if usage does not decrease after a deletion', async () => {
    await seed('a', '2026-01-01T00:00:00.000Z');
    await seed('b', '2026-02-01T00:00:00.000Z');
    const report = await enforceQuota(async () => ({ usage: 90, quota: 100 }));
    expect(report.deletedSessionIds).toEqual(['a']);
    expect(await sessionHasChunks('b')).toBe(true);
  });

  it('sets the warning flag when still over 80%', async () => {
    await seed('only', '2026-01-01T00:00:00.000Z', 'failed');
    const report = await enforceQuota(async () => ({ usage: 90, quota: 100 }));
    expect(report.warning).toBe(true);
    expect(storage.quotaWarning).toBe(true);
    expect(report.deletedSessionIds).toEqual(['only']);
  });

  it('clears the warning flag once usage is at or below 80%', async () => {
    await seed('old', '2026-01-01T00:00:00.000Z');
    let usage = 90;
    const report = await enforceQuota(async () => {
      const current = usage;
      if (usage > 70) usage = 60;
      return { usage: current, quota: 100 };
    });
    expect(report.deletedSessionIds).toEqual(['old']);
    expect(report.warning).toBe(false);
    expect(storage.quotaWarning).toBe(false);
    expect(await sessionHasChunks('old')).toBe(false);
  });
});
