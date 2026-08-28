import type { TranscriptSegment } from '@scribetab/shared';
import type { PendingChunk } from '@/utils/pendingChunks';

export function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function SegmentList({
  segments,
  pending,
  empty,
}: {
  segments: TranscriptSegment[];
  pending?: readonly PendingChunk[];
  empty: string;
}) {
  const pendingRows = pending ?? [];
  if (segments.length === 0 && pendingRows.length === 0) {
    return <p class="st-empty">{empty}</p>;
  }
  return (
    <ol class="st-segments">
      {segments.map((s) => (
        <li key={s.id}>
          <span class="st-time">{fmt(s.startMs)}</span>
          <span class="st-text" style={s.text === '[transcription failed]' ? { color: 'var(--st-danger)' } : undefined}>
            {s.speaker && <strong>{s.speaker}: </strong>}
            {s.text}
          </span>
        </li>
      ))}
      {pendingRows.map((p) => (
        <li key={`pending-${p.chunkIndex}`} class="st-segment--pending">
          <span class="st-time">{fmt(p.startMs)}</span>
          <span class="st-text">
            <span class="st-shimmer" />
            Transcribing…
          </span>
        </li>
      ))}
    </ol>
  );
}
