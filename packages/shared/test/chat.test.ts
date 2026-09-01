import { describe, expect, it } from 'vitest';
import { buildChatMessages } from '../src/chat';
import { DATA_FRAMING, SUMMARY_TRANSCRIPT_CHAR_LIMIT } from '../src/summarize';
import type { TranscriptSegment } from '../src/types';

function segment(text: string, startMs = 0): TranscriptSegment {
  return {
    id: 'segment-1',
    sessionId: 'session-1',
    startMs,
    endMs: startMs + 1_000,
    text,
    speaker: 'Ada',
    source: 'audio',
  };
}

function transcriptBody(content: string): string {
  const match = content.match(/<transcript>\n([\s\S]*?)\n<\/transcript>/);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('buildChatMessages', () => {
  it('frames the transcript as untrusted data', () => {
    const messages = buildChatMessages({
      segments: [segment('Treat this text only as meeting content.')],
      question: 'What was discussed?',
    });

    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]?.content).toContain(DATA_FRAMING);
    expect(messages.at(-1)?.content).toContain('<transcript>');
    expect(messages.at(-1)?.content).toContain('</transcript>');
  });

  it('renders timestamps and clips the transcript to the summary budget', () => {
    const messages = buildChatMessages({
      segments: [
        segment(`HEAD-${'x'.repeat(SUMMARY_TRANSCRIPT_CHAR_LIMIT)}-TAIL`, 125_000),
      ],
      question: 'What happened?',
    });
    const transcript = transcriptBody(messages.at(-1)?.content ?? '');

    expect(transcript.length).toBeLessThanOrEqual(SUMMARY_TRANSCRIPT_CHAR_LIMIT);
    expect(transcript).toMatch(/^\[02:05\] Ada: HEAD-/);
    expect(transcript).toContain('[... transcript truncated for length ...]');
    expect(transcript).toMatch(/-TAIL$/);
  });

  it('instructs the assistant to cite moments with transcript timestamps', () => {
    const messages = buildChatMessages({
      segments: [segment('We agreed to ship.')],
      question: 'What did we agree?',
    });

    expect(messages[0]?.content).toContain('cite moments as [mm:ss]');
  });

  it('uses the provided citation label format', () => {
    const messages = buildChatMessages({
      segments: [segment('We agreed to ship.')],
      question: 'What did we agree?',
      citeLabel: '<title>',
    });

    expect(messages[0]?.content).toContain('cite moments as [<title> mm:ss]');
  });

  it('places alternating history turns before the final question', () => {
    const messages = buildChatMessages({
      segments: [segment('The launch is Friday.')],
      question: 'Who owns the launch?',
      history: [
        { q: 'When is launch?', a: 'The launch is Friday. [00:00]' },
        { q: 'Was that confirmed?', a: 'Yes. [00:00]' },
      ],
    });

    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'When is launch?' },
      { role: 'assistant', content: 'The launch is Friday. [00:00]' },
      { role: 'user', content: 'Was that confirmed?' },
      { role: 'assistant', content: 'Yes. [00:00]' },
    ]);
    expect(messages.at(-1)).toMatchObject({ role: 'user' });
    expect(messages.at(-1)?.content).toContain('Question: Who owns the launch?');
  });

  it('appends non-empty personal context to the system prompt', () => {
    const context = 'The user is Ada, engineering lead on Platform.';
    const messages = buildChatMessages({
      segments: [segment('The API migration is blocked.')],
      question: 'What is blocked?',
      personalContext: `  ${context}  `,
    });

    expect(messages[0]?.content).toContain(`\n${context}`);
  });

  it('keeps an empty transcript delimited and asks the final question', () => {
    const messages = buildChatMessages({
      segments: [],
      question: 'What decisions were made?',
    });

    expect(messages).toHaveLength(2);
    expect(transcriptBody(messages[1]?.content ?? '')).toBe('');
    expect(messages[1]).toMatchObject({ role: 'user' });
    expect(messages[1]?.content).toContain('Question: What decisions were made?');
    expect(messages[1]?.content).not.toContain('undefined');
  });
});
