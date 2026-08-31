import { applySpeakerNames, normalizeSpeakerNames, type TranscriptSegment } from '@scribetab/shared';

export interface SpeakerRenameResult {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
}

interface SpeakerGroup {
  /** Label every row of the group currently renders as. */
  display: string;
  /** Raw row values that belong to the group — used to rewrite stored rows. */
  aliases: string[];
  /** Alias-map keys to repoint at the new name — used to rewrite the map. */
  keys: string[];
}

/**
 * Resolve one visible speaker label to the whole group behind it. `label` may be
 * an original alias ('spk_2'), a display name from the alias map ('Alice'), or a
 * raw label nobody has renamed yet. Speakers merged onto one display name share
 * a group, so renaming that label moves all of them together instead of
 * silently splitting the merge again.
 */
function speakerGroup(names: Record<string, string>, label: string): SpeakerGroup {
  const raw = label.trim();
  if (!raw) return { display: '', aliases: [], keys: [] };
  const display = (names[raw] ?? '').trim() || raw;
  const aliases = new Set<string>();
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(names)) {
    if (value.trim() === display) {
      aliases.add(key);
      keys.add(key);
    }
  }
  if (!(raw in names)) {
    // The label has no entry yet, so its rows already render as-is.
    aliases.add(raw);
    // If nothing has been renamed for this speaker, the label itself is the
    // alias — record it so rows that arrive later take the new name too.
    if (!keys.size) keys.add(raw);
  }
  // Rows written before the alias map existed carry the display value itself.
  if (!(display in names)) aliases.add(display);
  return { display, aliases: [...aliases], keys: [...keys] };
}

/** Display label a stored row renders under, given the alias map. */
function renderedSpeaker(names: Record<string, string>, speaker: string | undefined): string {
  const raw = speaker?.trim() ?? '';
  if (!raw) return '';
  return (names[raw] ?? '').trim() || raw;
}

/**
 * Display name that renaming `from` to `to` would merge two speakers under, or
 * null when the rename only changes one speaker's label. The other group has to
 * own rows — a stale alias entry alone is not a speaker — and must not already
 * be the group being renamed, which would make this a plain rename.
 *
 * Callers use this to ask first: a merge cannot be undone by renaming again,
 * because both groups collapse onto one label. `renameStoredSpeaker` performs
 * the merge either way, so asking never changes stored state.
 */
export function speakerMergeTarget(
  segments: readonly TranscriptSegment[],
  names: Record<string, string> | undefined,
  from: string,
  to: string,
): string | null {
  const currentNames = { ...(names ?? {}) };
  const target = to.trim();
  const source = speakerGroup(currentNames, from);
  if (!source.display || !target || source.display === target) return null;
  if (speakerGroup(currentNames, target).aliases.some((alias) => source.aliases.includes(alias))) {
    return null;
  }
  if (!segments.some((segment) => renderedSpeaker(currentNames, segment.speaker) === target)) return null;
  return target;
}

/**
 * Rename the display value for a speaker group. Stored rows may already contain
 * the prior display value, so both forms are rewritten.
 *
 * When `to` is already another speaker's display name this is a merge rather
 * than a duplicate: both groups map to `to`, and the group being merged into
 * keeps its original row keys — `distinctSpeakers(applyStoredSpeakerNames(...))`
 * collapses them by display name. An alias whose raw key already is `to` cannot
 * appear in the map (`normalizeSpeakerNames` drops identity rows); it renders as
 * `to` on its own.
 */
export function renameStoredSpeaker(
  segments: readonly TranscriptSegment[],
  names: Record<string, string> | undefined,
  from: string,
  to: string,
): SpeakerRenameResult {
  const currentNames = { ...(names ?? {}) };
  const copied = segments.map((segment) => ({ ...segment }));
  const source = speakerGroup(currentNames, from);
  const target = to.trim();
  // Nothing to rename onto: keep the rows as they are rather than blanking speakers.
  if (!source.display || !target) {
    return { segments: copied, speakerNames: normalizeSpeakerNames(currentNames) };
  }
  return {
    // Every alias that shares the old label moves with it, so a merged group
    // stays merged the next time its name changes.
    speakerNames: normalizeSpeakerNames({
      ...currentNames,
      ...Object.fromEntries(source.keys.map((alias) => [alias, target])),
    }),
    segments: copied.map((segment) =>
      segment.speaker && source.aliases.includes(segment.speaker.trim())
        ? { ...segment, speaker: target }
        : segment,
    ),
  };
}

export function applyStoredSpeakerNames(
  segments: readonly TranscriptSegment[],
  names: Record<string, string> | undefined,
): TranscriptSegment[] {
  return applySpeakerNames(segments, names);
}
