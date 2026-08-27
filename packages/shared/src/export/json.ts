import type { MeetingSession, TranscriptSegment } from '../types.js';
import type { ExportExtras } from './extras.js';
import { orderedSegments } from './order.js';

export function exportJson(
  session: MeetingSession,
  segments: TranscriptSegment[],
  extras?: ExportExtras,
): string {
  const body: Record<string, unknown> = {
    session,
    segments: orderedSegments(segments),
  };
  if (extras?.summaryMarkdown !== undefined) body.summaryMarkdown = extras.summaryMarkdown;
  if (extras?.costUsd !== undefined) body.costUsd = extras.costUsd;
  return JSON.stringify(body, null, 2) + '\n';
}
