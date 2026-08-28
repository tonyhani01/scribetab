import { applySpeakerNames, normalizeSpeakerNames, type TranscriptSegment } from '@scribetab/shared';

export interface SpeakerRenameResult {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
}

/**
 * Rename the display value for an original speaker alias. Stored rows may
 * already contain the prior display value, so both forms are rewritten.
 */
export function renameStoredSpeaker(
  segments: readonly TranscriptSegment[],
  names: Record<string, string> | undefined,
  from: string,
  to: string,
): SpeakerRenameResult {
  const currentNames = { ...(names ?? {}) };
  const original = currentNames[from]
    ? from
    : Object.entries(currentNames).find(([, display]) => display === from)?.[0] ?? from;
  const currentDisplay = currentNames[original] ?? original;
  // normalize drops identity renames, so undoing a rename clears the entry
  // instead of persisting an inert { alias: alias } row.
  const nextNames = normalizeSpeakerNames({ ...currentNames, [original]: to });
  return {
    speakerNames: nextNames,
    segments: segments.map((segment) =>
      segment.speaker === original || segment.speaker === currentDisplay
        ? { ...segment, speaker: to }
        : { ...segment },
    ),
  };
}

export function applyStoredSpeakerNames(
  segments: readonly TranscriptSegment[],
  names: Record<string, string> | undefined,
): TranscriptSegment[] {
  return applySpeakerNames(segments, names);
}
