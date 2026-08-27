import type { MeetingSession, TranscriptSegment } from '../types.js';
import { preparedCues } from './cues.js';
import { formatSrtTime } from './timestamps.js';

export function exportSrt(_session: MeetingSession, segments: TranscriptSegment[]): string {
  const cues = preparedCues(segments);
  if (cues.length === 0) return '';
  const blocks = cues.map((cue, i) => {
    const text = cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text;
    return `${i + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${text}\n`;
  });
  return blocks.join('\n') + '\n';
}
