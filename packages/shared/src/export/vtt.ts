import type { MeetingSession, TranscriptSegment } from '../types';
import { orderedSegments } from './order';
import { formatVttTime } from './timestamps';

export function exportVtt(_session: MeetingSession, segments: TranscriptSegment[]): string {
  const ordered = orderedSegments(segments);
  const cues = ordered.map((seg) => {
    const text = seg.speaker ? `<v ${seg.speaker}>${seg.text}` : seg.text;
    return `${formatVttTime(seg.startMs)} --> ${formatVttTime(seg.endMs)}\n${text}\n`;
  });
  return ['WEBVTT', '', ...cues].join('\n').replace(/\n+$/, '\n');
}
