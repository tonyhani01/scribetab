import type { ChatMessage, TranscriptSegment } from './types.js';

export function transcriptPlain(segments: Pick<TranscriptSegment, 'speaker' | 'text'>[]): string {
  return segments
    .map((s) => {
      const text = s.text.trim();
      if (!text) return '';
      return s.speaker ? `${s.speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
}

export function buildSummaryMessages(transcript: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You write concise meeting summaries. Reply with plain markdown paragraphs only — no title heading, no preamble.',
    },
    {
      role: 'user',
      content: `Summarize this meeting transcript in 1–3 short paragraphs. Cover decisions, open questions, and outcomes.\n\n${transcript}`,
    },
  ];
}

export function buildActionItemMessages(transcript: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You extract action items from meeting transcripts. Reply with a markdown checklist only, one item per line, using `- [ ] owner — task` when an owner is named. If there are no action items, reply with `- [ ] None identified`.',
    },
    {
      role: 'user',
      content: `Extract action items from this transcript.\n\n${transcript}`,
    },
  ];
}

export function parseSummary(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  if (fenced?.[1]) text = fenced[1].trim();
  return text;
}

function toChecklistLine(line: string): string {
  let rest = line.trim();
  rest = rest.replace(/^[-*]\s+/, '');
  rest = rest.replace(/^\d+\.\s+/, '');
  const m = rest.match(/^\[([ xX])\]\s*(.*)$/);
  if (m) {
    const box = m[1]!.toLowerCase() === 'x' ? '[x]' : '[ ]';
    return `- ${box} ${m[2]}`.trimEnd();
  }
  return `- [ ] ${rest}`;
}

export function parseActionItems(raw: string): string {
  const text = parseSummary(raw);
  if (!text) return '- [ ] None identified';
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(toChecklistLine)
    .join('\n');
}

export function combineSummaryMarkdown(summary: string, actionItems: string): string {
  const s = summary.trim();
  const a = actionItems.trim() || '- [ ] None identified';
  const parts = ['## Summary', '', s || '(no summary)', '', '## Action items', '', a];
  return parts.join('\n') + '\n';
}

export async function summarizeMeeting(
  complete: (messages: ChatMessage[]) => Promise<string>,
  segments: Pick<TranscriptSegment, 'speaker' | 'text'>[],
): Promise<string> {
  const transcript = transcriptPlain(segments);
  if (!transcript) return '';
  const [summaryRaw, actionsRaw] = await Promise.all([
    complete(buildSummaryMessages(transcript)),
    complete(buildActionItemMessages(transcript)),
  ]);
  return combineSummaryMarkdown(parseSummary(summaryRaw), parseActionItems(actionsRaw));
}
