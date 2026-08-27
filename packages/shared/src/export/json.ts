import type { MeetingSession, TranscriptSegment } from '../types.js';
import { orderedSegments } from './order.js';

export function exportJson(session: MeetingSession, segments: TranscriptSegment[]): string {
  return JSON.stringify({ session, segments: orderedSegments(segments) }, null, 2) + '\n';
}
