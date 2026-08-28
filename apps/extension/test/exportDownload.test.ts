import { describe, expect, it } from 'vitest';
import type { MeetingSession } from '@scribetab/shared';
import { exportBody, extrasFromSession, exportFilename, sessionSlug } from '../utils/exportDownload';

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
    expect(extrasFromSession({ ...session, costUsd: null })).toEqual({ costUsd: null });
  });

  it('copies structured summary when present', () => {
    const summary = {
      version: 1 as const,
      narrative: 'Hi',
      actionItems: [],
      decisions: [],
      usefulInfo: [],
      generatedAt: '2026-08-28T00:00:00.000Z',
    };
    expect(extrasFromSession({ ...session, summaryMarkdown: '## Summary', summary })).toEqual({
      summaryMarkdown: '## Summary',
      summary,
    });
  });

  it('merges separately supplied highlights into session export extras', () => {
    expect(
      extrasFromSession(
        {
          ...session,
          summaryMarkdown: '## Summary',
          highlights: [{ startMs: 900, label: 'ship it' }],
        },
        { highlights: [{ startMs: 100, text: 'decision context' }] },
      ),
    ).toEqual({
      summaryMarkdown: '## Summary',
      highlights: [
        { startMs: 900, label: 'ship it' },
        { startMs: 100, text: 'decision context' },
      ],
    });
  });
});

describe('exportBody', () => {
  it('preserves session extras and adds highlight extras for markdown', () => {
    const body = exportBody(
      { ...session, summaryMarkdown: '## Summary' } as typeof session & { summaryMarkdown: string },
      [],
      'md',
      { highlights: [{ startMs: 250, text: 'nearby transcript' }] },
    );
    expect(body).toContain('## Summary');
    expect(body).toContain('00:00:00');
    expect(body).toContain('nearby transcript');
  });
});

describe('export filenames', () => {
  it('slugifies the title and prefixes the date', () => {
    expect(sessionSlug('Weekly Standup!!')).toBe('weekly-standup');
    expect(exportFilename(session, 'md')).toBe('scribetab-2026-08-27-weekly-standup.md');
    expect(exportFilename(session, 'vtt')).toBe('scribetab-2026-08-27-weekly-standup.vtt');
    expect(exportFilename(session, 'notebooklm')).toBe(
      'scribetab-notebooklm-2026-08-27-weekly-standup.md',
    );
  });
});
