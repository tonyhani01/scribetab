import { describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '../src/types';
import { exportJson } from '../src/export/json';
import { exportMarkdown } from '../src/export/markdown';
import { exportNotebookLm } from '../src/export/notebooklm';
import { exportSrt } from '../src/export/srt';
import { exportVtt } from '../src/export/vtt';

const session: MeetingSession = {
  id: 'sess-1',
  title: 'Weekly standup',
  startedAt: '2026-08-27T10:00:00.000Z',
  endedAt: '2026-08-27T10:30:00.000Z',
  platform: 'meet',
  tabUrl: 'https://meet.google.com/abc-defg-hij',
  status: 'complete',
};

const segments: TranscriptSegment[] = [
  {
    id: 'b',
    sessionId: 'sess-1',
    startMs: 61_012,
    endMs: 64_500,
    text: 'Second line',
    source: 'audio',
  },
  {
    id: 'a',
    sessionId: 'sess-1',
    startMs: 0,
    endMs: 2_500,
    text: 'Hello team',
    speaker: 'Ada',
    source: 'audio',
  },
];

describe('exportMarkdown', () => {
  it('includes title, metadata, speaker lines, and start timestamps', () => {
    const md = exportMarkdown(session, segments);
    expect(md).toContain('# Weekly standup');
    expect(md).toContain('2026-08-27T10:00:00.000Z');
    expect(md).toContain('meet');
    expect(md).toMatch(/\*\*\[00:00:00\] Ada:\*\* Hello team/);
    expect(md).toMatch(/\*\*\[00:01:01\]\*\* Second line/);
  });

  it('orders by startMs even when input is unsorted', () => {
    const md = exportMarkdown(session, segments);
    expect(md.indexOf('Hello team')).toBeLessThan(md.indexOf('Second line'));
  });

  it('does not mutate the input array', () => {
    const copy = segments.slice();
    exportMarkdown(session, segments);
    expect(segments.map((s) => s.id)).toEqual(copy.map((s) => s.id));
  });

  it('emits a header and no body lines when there are no segments', () => {
    const md = exportMarkdown(session, []);
    expect(md).toContain('# Weekly standup');
    expect(md).not.toContain('Hello team');
  });

  it('includes summary markdown and estimated cost when provided', () => {
    const md = exportMarkdown(session, segments, {
      summaryMarkdown: '## Summary\n\nShip it.\n\n## Action items\n\n- [ ] Recap',
      costUsd: 0.006,
    });
    expect(md).toContain('- Estimated cost (USD): $0.0060');
    expect(md).toContain('## Summary');
    expect(md).toContain('Ship it.');
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Transcript'));
  });
});

describe('exportJson', () => {
  it('serializes session and ordered segments as pretty JSON', () => {
    const parsed = JSON.parse(exportJson(session, segments)) as {
      session: MeetingSession;
      segments: TranscriptSegment[];
    };
    expect(parsed.session).toEqual(session);
    expect(parsed.segments.map((s) => s.id)).toEqual(['a', 'b']);
    expect(parsed.segments[0]?.speaker).toBe('Ada');
  });

  it('emits an empty segments array when there are none', () => {
    const parsed = JSON.parse(exportJson(session, [])) as { segments: unknown[] };
    expect(parsed.segments).toEqual([]);
  });

  it('includes summaryMarkdown and costUsd extras without mutating session', () => {
    const parsed = JSON.parse(
      exportJson(session, segments, { summaryMarkdown: '## Summary\n\nHi', costUsd: 0.01 }),
    ) as { session: MeetingSession; summaryMarkdown: string; costUsd: number };
    expect(parsed.summaryMarkdown).toBe('## Summary\n\nHi');
    expect(parsed.costUsd).toBe(0.01);
    expect(parsed.session).toEqual(session);
    expect('summaryMarkdown' in parsed.session).toBe(false);
  });
});

describe('exportSrt', () => {
  it('formats 1-based cues with comma milliseconds and speaker prefix', () => {
    const srt = exportSrt(session, segments);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\nAda: Hello team\n');
    expect(srt).toContain('2\n00:01:01,012 --> 00:01:04,500\nSecond line\n');
  });

  it('pads hours and formats a time past one hour', () => {
    const late: TranscriptSegment[] = [
      {
        id: 'h',
        sessionId: 'sess-1',
        startMs: 3_661_012,
        endMs: 3_662_000,
        text: 'After an hour',
        source: 'audio',
      },
    ];
    expect(exportSrt(session, late)).toContain('01:01:01,012 --> 01:01:02,000');
  });

  it('returns an empty string for no segments', () => {
    expect(exportSrt(session, [])).toBe('');
  });

  it('orders cues by startMs', () => {
    const srt = exportSrt(session, segments);
    expect(srt.indexOf('Hello team')).toBeLessThan(srt.indexOf('Second line'));
  });

  it('collapses blank lines and neutralizes --> in cue text', () => {
    const messy: TranscriptSegment[] = [
      {
        id: 'm',
        sessionId: 'sess-1',
        startMs: 0,
        endMs: 1000,
        text: 'line one\n\nline two --> still text',
        source: 'audio',
      },
    ];
    const srt = exportSrt(session, messy);
    expect(srt).not.toMatch(/\n\nline/);
    expect(srt).toContain('line one\nline two -- > still text');
    expect(srt).not.toContain('--> still');
  });

  it('skips cues with non-finite, reversed, or zero-length timestamps', () => {
    const bad: TranscriptSegment[] = [
      { id: 'nan', sessionId: 'sess-1', startMs: Number.NaN, endMs: 1000, text: 'nan', source: 'audio' },
      { id: 'rev', sessionId: 'sess-1', startMs: 2000, endMs: 1000, text: 'reversed', source: 'audio' },
      { id: 'zero', sessionId: 'sess-1', startMs: 500, endMs: 500, text: 'zero', source: 'audio' },
      { id: 'ok', sessionId: 'sess-1', startMs: 0, endMs: 1000, text: 'kept', source: 'audio' },
    ];
    const srt = exportSrt(session, bad);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\nkept\n');
    expect(srt).not.toContain('nan');
    expect(srt).not.toContain('reversed');
    expect(srt).not.toContain('zero');
  });
});

describe('exportVtt', () => {
  it('starts with WEBVTT and uses dot milliseconds plus voice tags', () => {
    const vtt = exportVtt(session, segments);
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500\n<v Ada>Hello team');
    expect(vtt).toContain('00:01:01.012 --> 00:01:04.500\nSecond line');
  });

  it('still emits WEBVTT when there are no segments', () => {
    expect(exportVtt(session, []).trim()).toBe('WEBVTT');
  });

  it('orders cues by startMs', () => {
    const vtt = exportVtt(session, segments);
    expect(vtt.indexOf('Hello team')).toBeLessThan(vtt.indexOf('Second line'));
  });

  it('escapes &, <, > in cue text and voice-span speaker names', () => {
    const tagged: TranscriptSegment[] = [
      {
        id: 'e',
        sessionId: 'sess-1',
        startMs: 0,
        endMs: 1000,
        text: 'A & B <C>',
        speaker: 'Ann & Bob <mod>',
        source: 'audio',
      },
    ];
    const vtt = exportVtt(session, tagged);
    expect(vtt).toContain('<v Ann &amp; Bob &lt;mod&gt;>A &amp; B &lt;C&gt;');
    expect(vtt).not.toContain('A & B');
    expect(vtt).not.toContain('<C>');
  });

  it('collapses blank lines and neutralizes --> in cue text', () => {
    const messy: TranscriptSegment[] = [
      {
        id: 'm',
        sessionId: 'sess-1',
        startMs: 0,
        endMs: 1000,
        text: 'alpha\n\nbeta --> gamma',
        source: 'audio',
      },
    ];
    const vtt = exportVtt(session, messy);
    expect(vtt).toContain('alpha\nbeta -- &gt; gamma');
    expect(vtt).not.toContain('--> gamma');
  });

  it('skips cues with non-finite, reversed, or zero-length timestamps', () => {
    const bad: TranscriptSegment[] = [
      { id: 'nan', sessionId: 'sess-1', startMs: Number.POSITIVE_INFINITY, endMs: 1000, text: 'inf', source: 'audio' },
      { id: 'rev', sessionId: 'sess-1', startMs: 5, endMs: 1, text: 'reversed', source: 'audio' },
      { id: 'zero', sessionId: 'sess-1', startMs: 0, endMs: 0, text: 'zero', source: 'audio' },
      { id: 'ok', sessionId: 'sess-1', startMs: 0, endMs: 1000, text: 'kept', source: 'audio' },
    ];
    const vtt = exportVtt(session, bad);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000\nkept');
    expect(vtt).not.toContain('inf');
    expect(vtt).not.toContain('reversed');
    expect(vtt).not.toContain('zero');
  });
});

describe('exportNotebookLm', () => {
  it('adds a NotebookLM header and combines summary with transcript', () => {
    const md = exportNotebookLm(session, segments, {
      summaryMarkdown: '## Recap\n\nShip it.',
    });
    expect(md).toContain('# Weekly standup');
    expect(md).toContain('Exported for NotebookLM from ScribeTab.');
    expect(md).toContain(`- Session ID: ${session.id}`);
    expect(md).toContain('## Recap');
    expect(md).toContain('Ship it.');
    expect(md).toContain('[00:00:00] Ada: Hello team');
    expect(md).toContain('[00:01:01] Second line');
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Transcript'));
    expect(md.indexOf('Hello team')).toBeLessThan(md.indexOf('Second line'));
  });

  it('omits the summary section when none is provided', () => {
    const md = exportNotebookLm(session, []);
    expect(md).toContain('Exported for NotebookLM from ScribeTab.');
    expect(md).not.toContain('## Summary');
    expect(md).toContain('## Transcript');
  });
});
