import { formatUsd } from '../costs.js';
import type { MeetingSession, TranscriptSegment } from '../types.js';
import type { ExportExtras } from './extras.js';
import { orderedSegments } from './order.js';
import { formatClock } from './timestamps.js';

/** How the transcript body of a markdown export is rendered. */
export interface TranscriptExportOptions {
  /** Prefix each paragraph with `[HH:MM:SS]`. Default true. */
  timestamps?: boolean;
  /** Prefix each paragraph with the speaker label. Default true. */
  speakers?: boolean;
  /** Merge consecutive paragraphs by the same speaker into one. Default false. */
  combineSameSpeaker?: boolean;
}

export type ResolvedTranscriptExportOptions = Required<TranscriptExportOptions>;

export const DEFAULT_TRANSCRIPT_EXPORT_OPTIONS: ResolvedTranscriptExportOptions = {
  timestamps: true,
  speakers: true,
  combineSameSpeaker: false,
};

/** Non-boolean values (corrupted storage, hand-built payloads) fall back. */
function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Fill in explicit booleans for every transcript rendering option. */
export function resolveTranscriptExportOptions(
  options?: TranscriptExportOptions,
): ResolvedTranscriptExportOptions {
  return {
    timestamps: flag(options?.timestamps, DEFAULT_TRANSCRIPT_EXPORT_OPTIONS.timestamps),
    speakers: flag(options?.speakers, DEFAULT_TRANSCRIPT_EXPORT_OPTIONS.speakers),
    combineSameSpeaker: flag(
      options?.combineSameSpeaker,
      DEFAULT_TRANSCRIPT_EXPORT_OPTIONS.combineSameSpeaker,
    ),
  };
}

/** A rendered transcript block: one line per segment, or per speaker run when combining. */
interface Paragraph {
  /** Session-relative start of the run — the first segment's timestamp. */
  startMs: number;
  /** Trimmed speaker label, '' when the segment has no speaker. */
  speaker: string;
  text: string;
}

/** Append merged text without leaving double spaces when a segment is blank. */
function appendText(previous: string, next: string): string {
  const tail = next.trim();
  const head = previous.trimEnd();
  return tail ? `${head} ${tail}` : head;
}

function toParagraphs(
  segments: readonly TranscriptSegment[],
  combineSameSpeaker: boolean,
): Paragraph[] {
  const out: Paragraph[] = [];
  for (const seg of orderedSegments(segments)) {
    const speaker = seg.speaker?.trim() ?? '';
    const previous = out[out.length - 1];
    // Segments without a speaker label are their own group, so two adjacent
    // unlabelled lines only merge with each other, never with a named run.
    if (combineSameSpeaker && previous && previous.speaker === speaker) {
      previous.text = appendText(previous.text, seg.text);
      continue;
    }
    out.push({ startMs: seg.startMs, speaker, text: seg.text });
  }
  return out;
}

function renderParagraph(
  paragraph: Paragraph,
  options: ResolvedTranscriptExportOptions,
): string {
  const stamp = options.timestamps ? `[${formatClock(paragraph.startMs)}]` : '';
  const label = options.speakers ? paragraph.speaker : '';
  const prefix = [stamp, label].filter(Boolean).join(' ');
  if (!prefix) return paragraph.text;
  return `**${prefix}${label ? ':' : ''}** ${paragraph.text}`;
}

export function exportMarkdown(
  session: MeetingSession,
  segments: TranscriptSegment[],
  extras?: ExportExtras,
  transcriptOptions?: TranscriptExportOptions,
): string {
  const options = resolveTranscriptExportOptions(transcriptOptions);
  const lines: string[] = [
    `# ${session.title}`,
    '',
    `- Started: ${session.startedAt}`,
    `- Ended: ${session.endedAt ?? 'in progress'}`,
    `- Platform: ${session.platform}`,
  ];
  if (session.tabUrl) lines.push(`- URL: ${session.tabUrl}`);
  if (extras?.costUsd !== undefined) {
    lines.push(`- Estimated cost (USD): ${formatUsd(extras.costUsd)}`);
  }
  if (extras?.summaryMarkdown?.trim()) {
    lines.push('', extras.summaryMarkdown.trim());
  }
  if (extras?.highlights?.length) {
    lines.push('', '## Highlights', '');
    for (const hl of [...extras.highlights].sort((a, b) => a.startMs - b.startMs)) {
      const label = hl.label?.trim();
      const text = hl.text?.trim();
      const desc = label || text || '';
      lines.push(`- **[${formatClock(hl.startMs)}]**${desc ? ` ${desc}` : ''}`);
    }
  }
  lines.push('', '## Transcript', '');

  for (const paragraph of toParagraphs(segments, options.combineSameSpeaker)) {
    lines.push(renderParagraph(paragraph, options));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
