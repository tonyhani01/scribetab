import {
  exportJson,
  exportMarkdown,
  exportNotebookLm,
  exportSrt,
  exportVtt,
  type ExportExtras,
  type MeetingSession,
  type TranscriptExportOptions,
  type TranscriptSegment,
} from '@scribetab/shared';

export type ExportFormat = 'md' | 'json' | 'srt' | 'vtt' | 'notebooklm';

/** The part of `navigator.clipboard` this module needs; stubbable in tests. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** Clipboard available to this context, or null (insecure context, no user gesture, tests). */
export function clipboardWriter(): ClipboardWriter | null {
  const clipboard = (globalThis.navigator as { clipboard?: Partial<ClipboardWriter> } | undefined)
    ?.clipboard;
  return typeof clipboard?.writeText === 'function'
    ? (clipboard as ClipboardWriter)
    : null;
}

export function extrasFromSession(
  session: MeetingSession & ExportExtras,
  override?: ExportExtras,
): ExportExtras {
  const extras: ExportExtras = {};
  if (session.summaryMarkdown !== undefined) extras.summaryMarkdown = session.summaryMarkdown;
  if (session.summary !== undefined) extras.summary = session.summary;
  if (session.costUsd !== undefined) extras.costUsd = session.costUsd; // includes null → n/a
  if (session.highlights?.length) extras.highlights = [...session.highlights];
  if (session.speakerNames !== undefined) extras.speakerNames = { ...session.speakerNames };
  if (override) {
    Object.assign(extras, override);
    if (session.highlights?.length || override.highlights?.length) {
      extras.highlights = [...(session.highlights ?? []), ...(override.highlights ?? [])];
    }
  }
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
  const slug = sessionSlug(session.title);
  if (format === 'notebooklm') return `scribetab-notebooklm-${day}-${slug}.md`;
  return `scribetab-${day}-${slug}.${format}`;
}

export function exportBody(
  session: MeetingSession,
  segments: TranscriptSegment[],
  format: ExportFormat,
  extras?: ExportExtras,
  transcript?: TranscriptExportOptions,
): string {
  const merged = extrasFromSession(session as MeetingSession & ExportExtras, extras);
  // Transcript rendering options are markdown-only: caption formats carry their
  // own timing, and JSON exports keep the raw rows.
  if (format === 'md') return exportMarkdown(session, segments, merged, transcript);
  if (format === 'json') return exportJson(session, segments, merged);
  if (format === 'srt') return exportSrt(session, segments);
  if (format === 'notebooklm') return exportNotebookLm(session, segments, merged);
  return exportVtt(session, segments);
}

export async function downloadExport(
  session: MeetingSession & ExportExtras,
  segments: TranscriptSegment[],
  format: ExportFormat,
  extras?: ExportExtras,
  transcript?: TranscriptExportOptions,
): Promise<void> {
  const body = exportBody(session, segments, format, extras, transcript);
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

/**
 * Put the markdown export on the clipboard — same body as `Export .md`, same
 * transcript options, and it never leaves the machine. Pass a clipboard stub in
 * tests; `clipboardWriter()` covers the runtime (null when unavailable).
 */
export async function copyMarkdownExport(
  session: MeetingSession & ExportExtras,
  segments: TranscriptSegment[],
  transcript?: TranscriptExportOptions,
  extras?: ExportExtras,
  clipboard: ClipboardWriter | null = clipboardWriter(),
): Promise<void> {
  if (!clipboard) throw new Error('Clipboard is not available in this context.');
  await clipboard.writeText(exportBody(session, segments, 'md', extras, transcript));
}
