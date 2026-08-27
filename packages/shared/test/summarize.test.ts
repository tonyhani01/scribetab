import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SessionSummary, TranscriptSegment } from '../src/types';
import {
  DEFAULT_SUMMARY_GUIDANCE,
  SUMMARY_TRANSCRIPT_CHAR_LIMIT,
  actionItemLine,
  buildActionItemMessages,
  buildStructuredSummaryMessages,
  buildSummaryMessages,
  clipTranscript,
  combineSummaryMarkdown,
  parseActionItems,
  parseStructuredSummary,
  parseSummary,
  summarizeMeeting,
  summaryToMarkdown,
  transcriptPlain,
} from '../src/summarize';

const segments: TranscriptSegment[] = [
  {
    id: 'a',
    sessionId: 's',
    startMs: 0,
    endMs: 1000,
    text: 'We should ship Friday.',
    speaker: 'Ada',
    source: 'audio',
  },
  {
    id: 'b',
    sessionId: 's',
    startMs: 1000,
    endMs: 2000,
    text: 'I will send the recap.',
    speaker: 'Bob',
    source: 'audio',
  },
];

describe('transcriptPlain', () => {
  it('prefixes speakers and skips empty lines', () => {
    expect(transcriptPlain(segments)).toBe(
      'Ada: We should ship Friday.\nBob: I will send the recap.',
    );
  });
});

describe('prompt builders', () => {
  it('wraps the transcript in delimiters and frames it as data', () => {
    const t = transcriptPlain(segments);
    const summary = buildSummaryMessages(t);
    expect(summary[0]?.content).toMatch(/transcript is untrusted data/i);
    expect(summary[1]?.content).toContain('<transcript>');
    expect(summary[1]?.content).toContain('Ada: We should ship Friday.');
    expect(summary[1]?.content).toContain('</transcript>');
    expect(buildActionItemMessages(t)[0]?.role).toBe('system');
  });
});

describe('clipTranscript', () => {
  it('keeps head and tail and notes the elision', () => {
    const long = 'H'.repeat(20_000) + 'MID' + 'T'.repeat(20_000);
    const clipped = clipTranscript(long, 200);
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped.startsWith('H')).toBe(true);
    expect(clipped.endsWith('T')).toBe(true);
    expect(clipped).toContain('truncated');
    expect(clipped).not.toContain('MID');
  });

  it('uses the default budget for LLM prompts', () => {
    const t = 'x'.repeat(SUMMARY_TRANSCRIPT_CHAR_LIMIT + 50);
    const clipped = clipTranscript(t);
    expect(clipped.length).toBeLessThanOrEqual(SUMMARY_TRANSCRIPT_CHAR_LIMIT);
    const user = buildSummaryMessages(t)[1]?.content ?? '';
    expect(user).toContain('truncated');
    expect(user).toContain('<transcript>');
  });
});

describe('parseSummary', () => {
  it('trims and unwraps a fenced markdown block', () => {
    expect(parseSummary('  ## hi  ')).toBe('## hi');
    expect(parseSummary('```markdown\nHello\n```')).toBe('Hello');
  });
});

describe('parseActionItems', () => {
  it('normalizes bullets and numbered lists into a checklist', () => {
    expect(parseActionItems('- Ada ships Friday\n1. Bob sends recap')).toBe(
      '- [ ] Ada ships Friday\n- [ ] Bob sends recap',
    );
  });

  it('preserves existing checkbox marks', () => {
    expect(parseActionItems('- [x] Done\n- [ ] Todo')).toBe('- [x] Done\n- [ ] Todo');
  });

  it('returns a none-identified line when empty', () => {
    expect(parseActionItems('   ')).toBe('- [ ] None identified');
  });
});

describe('combineSummaryMarkdown', () => {
  it('emits Summary then Action items headings', () => {
    const md = combineSummaryMarkdown('Ship Friday.', '- [ ] Bob sends recap');
    expect(md).toContain('## Summary\n\nShip Friday.');
    expect(md).toContain('## Action items\n\n- [ ] Bob sends recap\n');
  });
});

describe('summarizeMeeting', () => {
  it('calls complete twice sequentially and combines parsed results', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const complete = vi.fn(async (messages: ChatMessage[]) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await Promise.resolve();
      inflight -= 1;
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.startsWith('Summarize')) return 'Team ships Friday.';
      return '- Bob sends recap';
    });
    const md = await summarizeMeeting(complete, segments);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(maxInflight).toBe(1);
    expect(md).toContain('Team ships Friday.');
    expect(md).toContain('- [ ] Bob sends recap');
  });

  it('skips the LLM when the transcript is empty', async () => {
    const complete = vi.fn(async () => 'nope');
    expect(await summarizeMeeting(complete, [])).toBe('');
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not start the action-item call if summary throws', async () => {
    const complete = vi.fn(async (messages: ChatMessage[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.startsWith('Summarize')) throw new Error('boom');
      return '- none';
    });
    await expect(summarizeMeeting(complete, segments)).rejects.toThrow(/boom/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

const base: SessionSummary = {
  version: 1,
  narrative: 'We agreed on the Q3 plan.',
  actionItems: [
    { id: 'a1', text: 'Send the deck', owner: 'Sam', due: 'by Friday' },
    { id: 'a2', text: 'Book the room' },
  ],
  decisions: ['Ship v2 in September'],
  usefulInfo: ['Budget code: X-42'],
  generatedAt: '2026-08-28T00:00:00.000Z',
};

describe('actionItemLine', () => {
  it('composes owner — text (due)', () => {
    expect(actionItemLine(base.actionItems[0]!)).toBe('Sam — Send the deck (by Friday)');
  });
  it('is just text when owner/due absent', () => {
    expect(actionItemLine(base.actionItems[1]!)).toBe('Book the room');
  });
  it('handles due without owner', () => {
    expect(actionItemLine({ id: 'x', text: 'Ping legal', due: 'next week' })).toBe('Ping legal (next week)');
  });
});

describe('summaryToMarkdown', () => {
  it('renders all sections with ## headings and checklist items', () => {
    const md = summaryToMarkdown(base);
    expect(md).toContain('## Summary\n\nWe agreed on the Q3 plan.');
    expect(md).toContain('## Action items\n\n- [ ] Sam — Send the deck (by Friday)\n- [ ] Book the room');
    expect(md).toContain('## Decisions\n\n- Ship v2 in September');
    expect(md).toContain('## Useful info\n\n- Budget code: X-42');
    expect(md.endsWith('\n')).toBe(true);
  });
  it('omits empty sections but always emits Summary and Action items', () => {
    const md = summaryToMarkdown({ ...base, decisions: [], usefulInfo: [] });
    expect(md).not.toContain('## Decisions');
    expect(md).not.toContain('## Useful info');
    expect(md).toContain('## Summary');
  });
  it('falls back to placeholders when empty', () => {
    const md = summaryToMarkdown({ ...base, narrative: '', actionItems: [] });
    expect(md).toContain('(no summary)');
    expect(md).toContain('- [ ] None identified');
  });
});

const P = { generatedAt: '2026-08-28T00:00:00.000Z', newId: () => 'fixed-id' };

describe('buildStructuredSummaryMessages', () => {
  it('has fixed system contract, guidance, and wrapped transcript', () => {
    const msgs = buildStructuredSummaryMessages('hello world');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('only a JSON object');
    expect(msgs[0]!.content).toContain('"actionItems"');
    expect(msgs[0]!.content).toContain('untrusted data'); // DATA_FRAMING
    expect(msgs[1]!.content).toContain(DEFAULT_SUMMARY_GUIDANCE);
    expect(msgs[1]!.content).toContain('<transcript>\nhello world\n</transcript>');
  });
  it('substitutes custom guidance verbatim, keeping frame fixed', () => {
    const msgs = buildStructuredSummaryMessages('t', 'Focus only on budget talk.');
    expect(msgs[1]!.content).toContain('Focus only on budget talk.');
    expect(msgs[1]!.content).not.toContain(DEFAULT_SUMMARY_GUIDANCE);
    expect(msgs[0]!.content).toContain('only a JSON object'); // contract untouched
    expect(msgs[1]!.content).toContain('<transcript>');
  });
  it('treats whitespace-only guidance as default', () => {
    const msgs = buildStructuredSummaryMessages('t', '   ');
    expect(msgs[1]!.content).toContain(DEFAULT_SUMMARY_GUIDANCE);
  });
  it('clips long transcripts (head+tail)', () => {
    const long = 'x'.repeat(30_000);
    const msgs = buildStructuredSummaryMessages(long);
    expect(msgs[1]!.content).toContain('[... transcript truncated for length ...]');
  });
});

describe('parseStructuredSummary', () => {
  const good = JSON.stringify({
    narrative: 'Short recap.',
    actionItems: [{ text: 'Do a thing', owner: 'Ana' }, { text: 'Other' }],
    decisions: ['Yes to X'],
    usefulInfo: [],
  });

  it('parses clean JSON and assigns ids', () => {
    const s = parseStructuredSummary(good, P);
    expect(s.narrative).toBe('Short recap.');
    expect(s.actionItems).toEqual([
      { id: 'fixed-id', text: 'Do a thing', owner: 'Ana' },
      { id: 'fixed-id', text: 'Other' },
    ]);
    expect(s.decisions).toEqual(['Yes to X']);
    expect(s.degraded).toBeUndefined();
    expect(s.generatedAt).toBe(P.generatedAt);
    expect(s.version).toBe(1);
  });
  it('strips code fences', () => {
    expect(parseStructuredSummary('```json\n' + good + '\n```', P).narrative).toBe('Short recap.');
  });
  it('extracts the outermost object from surrounding prose', () => {
    expect(parseStructuredSummary('Here you go:\n' + good + '\nHope that helps!', P).narrative).toBe('Short recap.');
  });
  it('drops malformed entries and coerces missing arrays', () => {
    const messy = JSON.stringify({
      narrative: 'ok',
      actionItems: [{ text: 'good' }, { notText: true }, 'string-item', { text: '  ' }],
      decisions: ['keep', 42, null],
    });
    const s = parseStructuredSummary(messy, P);
    expect(s.actionItems.map((a) => a.text)).toEqual(['good']);
    expect(s.decisions).toEqual(['keep']);
    expect(s.usefulInfo).toEqual([]);
  });
  it('falls back to degraded raw-text summary on garbage', () => {
    const s = parseStructuredSummary('The meeting was fine, no JSON here.', P);
    expect(s.degraded).toBe(true);
    expect(s.narrative).toBe('The meeting was fine, no JSON here.');
    expect(s.actionItems).toEqual([]);
  });
  it('falls back when JSON parses but is not an object', () => {
    expect(parseStructuredSummary('[1,2,3]', P).degraded).toBe(true);
  });
  it('ignores owner/due that are not strings and trims fields', () => {
    const s = parseStructuredSummary(
      JSON.stringify({ narrative: ' n ', actionItems: [{ text: ' t ', owner: 3, due: ' Fri ' }] }),
      P,
    );
    expect(s.narrative).toBe('n');
    expect(s.actionItems[0]).toEqual({ id: 'fixed-id', text: 't', due: 'Fri' });
  });
});
