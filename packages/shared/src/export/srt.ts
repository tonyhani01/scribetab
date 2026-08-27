import type { MeetingSession, TranscriptSegment } from '../types';
import { orderedSegments } from './order';
import { formatSrtTime } from './timestamps';

export function exportSrt(_session: MeetingSession, segments: TranscriptSegment[]): string {
  const ordered = orderedSegments(segments);
  if (ordered.length === 0) return '';
  const cues = ordered.map((seg, i) => {
    const text = seg.speaker ? `${seg.speaker}: ${seg.text}` : seg.text;
    return `${i + 1}\n${formatSrtTime(seg.startMs)} --> ${formatSrtTime(seg.endMs)}\n${text}\n`;
  });
  return cues.join('\n') + '\n';
}
