import type { MeetingSession, TranscriptSegment } from '../types';
import { escapeVtt, preparedCues } from './cues';
import { formatVttTime } from './timestamps';

export function exportVtt(_session: MeetingSession, segments: TranscriptSegment[]): string {
  const ordered = preparedCues(segments);
  const cues = ordered.map((cue) => {
    const body = cue.speaker
      ? `<v ${escapeVtt(cue.speaker)}>${escapeVtt(cue.text)}`
      : escapeVtt(cue.text);
    return `${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${body}\n`;
  });
  return ['WEBVTT', '', ...cues].join('\n').replace(/\n+$/, '\n');
}
