import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionSummary, TranscriptSegment } from '../src/types';
import {
  DEFAULT_SUMMARY_GUIDANCE,
  SUMMARY_TRANSCRIPT_CHAR_LIMIT,
  actionItemLine,
  buildStructuredSummaryMessages,
  clipTranscript,
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
    const user = buildStructuredSummaryMessages(t)[1]?.content ?? '';
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

describe('summarizeMeeting (structured)', () => {
  const segs = [
    { speaker: 'Ana', text: 'We decided to ship.' },
    { speaker: 'Bo', text: 'I will send the notes.' },
  ];
  const reply = JSON.stringify({
    narrative: 'Shipped decision.',
    actionItems: [{ text: 'Send the notes', owner: 'Bo' }],
    decisions: ['Ship it'],
    usefulInfo: [],
  });

  it('makes exactly one LLM call and returns a SessionSummary', async () => {
    const calls: ChatMessage[][] = [];
    const s = await summarizeMeeting(async (m) => { calls.push(m); return reply; }, segs, {
      generatedAt: 'T', newId: () => 'i',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]!.content).toContain('Ana: We decided to ship.');
    expect(s?.narrative).toBe('Shipped decision.');
    expect(s?.actionItems[0]?.owner).toBe('Bo');
  });
  it('returns undefined for an empty transcript without calling the LLM', async () => {
    const s = await summarizeMeeting(async () => { throw new Error('no'); }, [{ speaker: undefined, text: '  ' }]);
    expect(s).toBeUndefined();
  });
  it('passes guidance through', async () => {
    let userMsg = '';
    await summarizeMeeting(async (m) => { userMsg = m[1]!.content; return reply; }, segs, { guidance: 'Budget only.' });
    expect(userMsg).toContain('Budget only.');
  });
  it('degrades instead of throwing on non-JSON output', async () => {
    const s = await summarizeMeeting(async () => 'plain text', segs, { generatedAt: 'T' });
    expect(s?.degraded).toBe(true);
    expect(s?.narrative).toBe('plain text');
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
  it('extracts JSON when a stray brace follows the object', () => {
    const raw = '{"narrative":"A","actionItems":[]} Hope that helps :}';
    const s = parseStructuredSummary(raw, P);
    expect(s.narrative).toBe('A');
    expect(s.degraded).toBeUndefined();
  });
  it('ignores stray braces in trailing prose', () => {
    const s = parseStructuredSummary(good + '\nNote: use {curly} braces.', P);
    expect(s.narrative).toBe('Short recap.');
    expect(s.degraded).toBeUndefined();
  });
  it('skips a small earlier object in favor of the summary object', () => {
    const s = parseStructuredSummary('I used {} for empty. Here: ' + good, P);
    expect(s.narrative).toBe('Short recap.');
    expect(s.degraded).toBeUndefined();
  });
  it('parses JSON with trailing commas', () => {
    const raw = '{"narrative":"A","actionItems":[{"text":"Do it",}],}';
    const s = parseStructuredSummary(raw, P);
    expect(s.narrative).toBe('A');
    expect(s.actionItems[0]?.text).toBe('Do it');
    expect(s.degraded).toBeUndefined();
  });
  it('does not echo raw JSON in the degraded narrative', () => {
    const s = parseStructuredSummary('{"narrative": broken', P);
    expect(s.degraded).toBe(true);
    expect(s.narrative).toBe('');
    expect(s.narrative).not.toContain('{');
  });
  it('collapses newlines in list fields to a single line', () => {
    const s = parseStructuredSummary(
      JSON.stringify({
        narrative: 'keep\nnewlines',
        actionItems: [{ text: 'a\nb', owner: 'Ann\nLee', due: 'by\nFriday' }],
        decisions: ['x\ny'],
        usefulInfo: ['p\nq'],
      }),
      P,
    );
    expect(s.narrative).toBe('keep\nnewlines');
    expect(s.actionItems[0]).toEqual({ id: 'fixed-id', text: 'a b', owner: 'Ann Lee', due: 'by Friday' });
    expect(s.decisions).toEqual(['x y']);
    expect(s.usefulInfo).toEqual(['p q']);
    const md = summaryToMarkdown(s);
    expect(md).toContain('- [ ] Ann Lee — a b (by Friday)');
    expect(md).toContain('- x y');
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
