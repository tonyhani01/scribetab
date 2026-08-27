import {
  exportJson,
  exportMarkdown,
  exportSrt,
  exportVtt,
  type ExportExtras,
  type MeetingSession,
  type TranscriptSegment,
} from '@scribetab/shared';

export type ExportFormat = 'md' | 'json' | 'srt' | 'vtt';

export function extrasFromSession(session: MeetingSession & ExportExtras): ExportExtras {
  const extras: ExportExtras = {};
  if (session.summaryMarkdown !== undefined) extras.summaryMarkdown = session.summaryMarkdown;
  if (session.costUsd !== undefined) extras.costUsd = session.costUsd;
  return extras;
}

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
  extras?: ExportExtras,
): string {
  if (format === 'md') return exportMarkdown(session, segments, extras);
  if (format === 'json') return exportJson(session, segments, extras);
  if (format === 'srt') return exportSrt(session, segments);
  return exportVtt(session, segments);
}

export async function downloadExport(
  session: MeetingSession & ExportExtras,
  segments: TranscriptSegment[],
  format: ExportFormat,
): Promise<void> {
  const body = exportBody(session, segments, format, extrasFromSession(session));
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
