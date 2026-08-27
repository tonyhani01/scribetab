import {
  exportJson,
  exportMarkdown,
  exportSrt,
  exportVtt,
  type MeetingSession,
  type TranscriptSegment,
} from '@scribetab/shared';

export type ExportFormat = 'md' | 'json' | 'srt' | 'vtt';

const EXPORTERS: Record<ExportFormat, (s: MeetingSession, segs: TranscriptSegment[]) => string> = {
  md: exportMarkdown,
  json: exportJson,
  srt: exportSrt,
  vtt: exportVtt,
};

export function sessionSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'meeting';
}

export function exportFilename(session: MeetingSession, format: ExportFormat): string {
  const day = session.startedAt.slice(0, 10);
  return `scribetab-${day}-${sessionSlug(session.title)}.${format}`;
}

export function exportBody(
  session: MeetingSession,
  segments: TranscriptSegment[],
  format: ExportFormat,
): string {
  return EXPORTERS[format](session, segments);
}

export async function downloadExport(
  session: MeetingSession,
  segments: TranscriptSegment[],
  format: ExportFormat,
): Promise<void> {
  const body = exportBody(session, segments, format);
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: exportFilename(session, format),
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
  }
}
