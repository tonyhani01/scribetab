import type { SessionSummary } from '../types.js';

export interface ExportExtras {
  summaryMarkdown?: string;
  summary?: SessionSummary;
  /** null = computed but unknown (n/a). */
  costUsd?: number | null;
  /** User-flagged moments, rendered as a section in markdown exports. */
  highlights?: { startMs: number; label?: string; text?: string }[];
  /** Manual speaker renames (original → display) applied to this export. */
  speakerNames?: Record<string, string>;
}
