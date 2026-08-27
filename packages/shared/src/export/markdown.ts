import type { MeetingSession, TranscriptSegment } from '../types';
import { orderedSegments } from './order';
import { formatClock } from './timestamps';

export function exportMarkdown(session: MeetingSession, segments: TranscriptSegment[]): string {
  const lines: string[] = [
    `# ${session.title}`,
    '',
    `- Started: ${session.startedAt}`,
    `- Ended: ${session.endedAt ?? 'in progress'}`,
    `- Platform: ${session.platform}`,
  ];
  if (session.tabUrl) lines.push(`- URL: ${session.tabUrl}`);
  lines.push('', '## Transcript', '');

  for (const seg of orderedSegments(segments)) {
    const stamp = formatClock(seg.startMs);
    if (seg.speaker) {
      lines.push(`**[${stamp}] ${seg.speaker}:** ${seg.text}`);
    } else {
      lines.push(`**[${stamp}]** ${seg.text}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
