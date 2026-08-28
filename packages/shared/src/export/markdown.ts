import { formatUsd } from '../costs.js';
import type { MeetingSession, TranscriptSegment } from '../types.js';
import type { ExportExtras } from './extras.js';
import { orderedSegments } from './order.js';
import { formatClock } from './timestamps.js';

export function exportMarkdown(
  session: MeetingSession,
  segments: TranscriptSegment[],
  extras?: ExportExtras,
): string {
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
