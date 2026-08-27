import { describe, expect, it } from 'vitest';
import type { MeetingSession } from '@scribetab/shared';
import {
  isOverTarget,
  isOverWarn,
  nextSessionToDropAudio,
  usageRatio,
} from '../utils/quota';

const s = (over: Partial<MeetingSession>): MeetingSession => ({
  id: 'x',
  title: 't',
  startedAt: '2026-08-01T00:00:00.000Z',
  platform: 'other',
  status: 'complete',
  ...over,
});

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

  it('picks the oldest completed session that still has audio', () => {
    const sessions = [
      s({ id: 'rec', status: 'recording', startedAt: '2026-01-01T00:00:00.000Z' }),
      s({ id: 'fail', status: 'failed', startedAt: '2026-01-02T00:00:00.000Z' }),
      s({ id: 'new', startedAt: '2026-08-01T00:00:00.000Z' }),
      s({ id: 'old', startedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const withAudio = new Set(['rec', 'fail', 'new', 'old']);
    expect(nextSessionToDropAudio(sessions, withAudio)?.id).toBe('old');
  });

  it('skips completed sessions whose audio is already gone', () => {
    const sessions = [s({ id: 'empty', startedAt: '2026-01-01T00:00:00.000Z' })];
    expect(nextSessionToDropAudio(sessions, new Set())).toBeUndefined();
  });
});
