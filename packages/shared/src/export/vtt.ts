import type { MeetingSession, TranscriptSegment } from '../types.js';
import { escapeVtt, preparedCues } from './cues.js';
import { formatVttTime } from './timestamps.js';

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
