import type { MeetingSession, TranscriptSegment } from '../types';
import { orderedSegments } from './order';

export function exportJson(session: MeetingSession, segments: TranscriptSegment[]): string {
  return JSON.stringify({ session, segments: orderedSegments(segments) }, null, 2) + '\n';
}
