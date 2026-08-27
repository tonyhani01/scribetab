import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatTimestamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatTranscriptMarkdown(
  session: MeetingSession,
  segments: TranscriptSegment[],
): string {
  const lines: string[] = [
    `# ${session.title}`,
    '',
    `- id: ${session.id}`,
    `- started: ${session.startedAt}`,
  ];
  if (session.endedAt) lines.push(`- ended: ${session.endedAt}`);
  lines.push(`- platform: ${session.platform}`);
  if (session.tabUrl) lines.push(`- url: ${session.tabUrl}`);
  lines.push('', '## Transcript', '');
  if (segments.length === 0) {
    lines.push('_No transcript segments._', '');
  } else {
    for (const seg of segments) {
      const who = seg.speaker ? `**${seg.speaker}** ` : '';
      lines.push(`${who}[${formatTimestamp(seg.startMs)}] ${seg.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatTranscriptJson(
  session: MeetingSession,
  segments: TranscriptSegment[],
): string {
  return `${JSON.stringify({ session, segments }, null, 2)}\n`;
}
