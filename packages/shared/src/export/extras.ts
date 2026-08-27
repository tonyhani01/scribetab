import type { SessionSummary } from '../types.js';

export interface ExportExtras {
  summaryMarkdown?: string;
  summary?: SessionSummary;
  /** null = computed but unknown (n/a). */
  costUsd?: number | null;
}
