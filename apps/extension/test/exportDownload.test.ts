import { describe, expect, it } from 'vitest';
import type { MeetingSession } from '@scribetab/shared';
import { extrasFromSession, exportFilename, sessionSlug } from '../utils/exportDownload';

const session: MeetingSession = {
  id: 's',
  title: 'Weekly Standup!!',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'meet',
  status: 'complete',
};

describe('extrasFromSession', () => {
  it('copies summaryMarkdown and costUsd off the stored row', () => {
    expect(
      extrasFromSession({
        ...session,
        summaryMarkdown: '## Summary',
        costUsd: 0.01,
      }),
    ).toEqual({ summaryMarkdown: '## Summary', costUsd: 0.01 });
  });
});

describe('export filenames', () => {
  it('slugifies the title and prefixes the date', () => {
    expect(sessionSlug('Weekly Standup!!')).toBe('weekly-standup');
    expect(exportFilename(session, 'md')).toBe('scribetab-2026-08-27-weekly-standup.md');
    expect(exportFilename(session, 'vtt')).toBe('scribetab-2026-08-27-weekly-standup.vtt');
  });
});
