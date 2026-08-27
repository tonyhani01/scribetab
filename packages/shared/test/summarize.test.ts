import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, TranscriptSegment } from '../src/types';
import {
  buildActionItemMessages,
  buildSummaryMessages,
  combineSummaryMarkdown,
  parseActionItems,
  parseSummary,
  summarizeMeeting,
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
  it('put the transcript in the user message', () => {
    const t = transcriptPlain(segments);
    expect(buildSummaryMessages(t)[1]?.content).toContain('Ada: We should ship Friday.');
    expect(buildActionItemMessages(t)[0]?.role).toBe('system');
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
  it('calls complete twice and combines parsed results', async () => {
    const complete = vi.fn(async (messages: ChatMessage[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.startsWith('Summarize')) return 'Team ships Friday.';
      return '- Bob sends recap';
    });
    const md = await summarizeMeeting(complete, segments);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(md).toContain('Team ships Friday.');
    expect(md).toContain('- [ ] Bob sends recap');
  });

  it('skips the LLM when the transcript is empty', async () => {
    const complete = vi.fn(async () => 'nope');
    expect(await summarizeMeeting(complete, [])).toBe('');
    expect(complete).not.toHaveBeenCalled();
  });
});
