import {
  clipTranscript,
  DATA_FRAMING,
  SUMMARY_TRANSCRIPT_CHAR_LIMIT,
  transcriptWithTimestamps,
} from './summarize.js';
import type { ChatMessage, TranscriptSegment } from './types.js';

export function buildChatMessages(opts: {
  segments: TranscriptSegment[];
  question: string;
  history?: { q: string; a: string }[];
  personalContext?: string;
  citeLabel?: string;
}): ChatMessage[] {
  const citeLabel = opts.citeLabel?.trim();
  const citationFormat = citeLabel ? `[${citeLabel} mm:ss]` : '[mm:ss]';
  const personalContext = opts.personalContext?.trim();
  const systemPrompt =
    'You are an assistant answering questions about a meeting transcript. ' +
    `Answer ONLY from the transcript; cite moments as ${citationFormat}; ` +
    'say plainly when the answer is not in the transcript. ' +
    DATA_FRAMING;
  const transcript = clipTranscript(
    transcriptWithTimestamps(opts.segments),
    SUMMARY_TRANSCRIPT_CHAR_LIMIT,
  );
  const history: ChatMessage[] = (opts.history ?? []).flatMap(({ q, a }) => [
    { role: 'user', content: q },
    { role: 'assistant', content: a },
  ]);

  return [
    {
      role: 'system',
      content: personalContext ? `${systemPrompt}\n${personalContext}` : systemPrompt,
    },
    ...history,
    {
      role: 'user',
      content: `<transcript>\n${transcript}\n</transcript>\n\nQuestion: ${opts.question}`,
    },
  ];
}
