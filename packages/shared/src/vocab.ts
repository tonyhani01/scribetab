/**
 * Custom vocabulary: user terms that steer recognition, plus a corrections
 * dictionary.
 *
 * Two independent halves, from one settings field (`vocabTerms`, one entry per
 * line in the options page):
 *
 *   Kubernetes            → a *hint*: handed to providers that accept them
 *   teh=>the              → a *replacement*: applied to segment text at ingest
 *
 * Hints are advisory and only travel inside the configured provider's request
 * (Whisper-style `prompt` field, Deepgram `keyterm` params). Replacements run
 * locally on every provider — including the captions-only path, which never
 * calls STT — after redaction, before the segment is stored.
 */

export interface ParsedVocab {
  /** Plain terms for providers that take vocabulary hints, in entry order. */
  hints: string[];
  /** `wrong => right` pairs, applied in order. Empty right side deletes the term. */
  replacements: [string, string][];
}

/** Separator that turns a vocabulary line into a correction rule. */
export const VOCAB_ARROW = '=>';

/**
 * Whisper ignores prompt context past its 224-token ceiling and rejects an
 * over-long prompt outright, so hints are capped (~4 chars/token, kept whole).
 */
export const MAX_PROMPT_CHARS = 800;

/** Deepgram's keyterms are per-term params; 32 bounds the query string. */
export const MAX_KEYTERMS = 32;

function normalizeLines(lines: string[]): string[] {
  // Corrupted storage can hand us anything; never throw at capture time.
  if (!Array.isArray(lines)) return [];
  return lines.filter((l): l is string => typeof l === 'string');
}

/** Split settings lines into provider hints and `wrong => right` corrections. */
export function parseVocab(lines: string[]): ParsedVocab {
  const hints: string[] = [];
  const replacements: [string, string][] = [];
  const seen = new Set<string>();
  for (const raw of normalizeLines(lines)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(VOCAB_ARROW);
    if (at === -1) {
      if (seen.has(line)) continue;
      seen.add(line);
      hints.push(line);
      continue;
    }
    const wrong = line.slice(0, at).trim();
    const right = line.slice(at + VOCAB_ARROW.length).trim();
    if (!wrong) continue; // '=> fixed' has nothing to match on
    replacements.push([wrong, right]);
  }
  return { hints, replacements };
}

/** Join hints into a Whisper `prompt`; '' when nothing fits the budget. */
export function hintsToPrompt(hints: string[], maxChars: number = MAX_PROMPT_CHARS): string {
  let out = '';
  for (const raw of normalizeLines(hints)) {
    const term = raw.trim();
    if (!term) continue;
    const next = out ? `${out} ${term}` : term;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD = '[\\p{L}\\p{N}_]';

/** Whole-word, case-insensitive match that also works on punctuated terms (`c++`). */
function boundaryRegExp(term: string): RegExp | null {
  const escaped = escapeForRegExp(term);
  if (!escaped) return null;
  try {
    return new RegExp(`(?<!${WORD})${escaped}(?!${WORD})`, 'giu');
  } catch {
    return null;
  }
}

/** Re-apply the matched term's leading case to the replacement. */
function preserveCase(match: string, right: string): string {
  if (!right) return '';
  const first = match.charAt(0);
  const upper = first.toUpperCase();
  // Only letters with a case distinction carry their capitalisation across.
  if (first !== upper || first === first.toLowerCase()) return right;
  const head = right.codePointAt(0);
  if (head === undefined) return right;
  const headChar = String.fromCodePoint(head);
  return headChar.toUpperCase() + right.slice(headChar.length);
}

/** Apply `wrong => right` pairs to text, word-boundary safe, in list order. */
export function applyReplacements(
  text: string,
  replacements: [string, string][],
): string {
  if (!text || !Array.isArray(replacements)) return text;
  let out = text;
  for (const pair of replacements) {
    const wrong = pair?.[0];
    const right = pair?.[1];
    if (typeof wrong !== 'string' || typeof right !== 'string' || !wrong) continue;
    const re = boundaryRegExp(wrong);
    if (!re) continue;
    out = out.replace(re, (m) => preserveCase(m, right));
  }
  return out;
}

/**
 * Correct transcript text of segments destined for storage. Speaker labels are
 * left alone — they can be user-chosen display names, not transcribed output.
 */
export function applyReplacementsToSegments<T extends { text: string }>(
  segments: T[],
  replacements: [string, string][],
): T[] {
  if (!Array.isArray(replacements) || replacements.length === 0) return segments;
  return segments.map((seg) => ({ ...seg, text: applyReplacements(seg.text, replacements) }));
}
