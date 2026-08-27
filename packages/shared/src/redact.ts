/**
 * Text-only PII redaction.
 *
 * Scope (honest): this pass runs on transcript *text* and *speaker* — before
 * an LLM call, and before IndexedDB storage when "redact at rest" is enabled.
 * Raw audio sent to an STT provider cannot be pre-redacted. Retained WAV
 * files are likewise unredacted.
 */

export interface RedactOptions {
  extraTerms?: string[];
}

const PLACEHOLDER_RE = /\[(EMAIL|CARD|SSN|PHONE|REDACTED)\]/g;

// Linear: bounded quantifiers, no nested unbounded groups.
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@(?:[A-Z0-9-]{1,63}\.){1,8}[A-Z]{2,24}/gi;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// 13–19 digits with spaces, dashes, or dots; Luhn-checked after strip.
const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ .\-]*?){13,19}(?!\d)/g;

const PHONE_PATTERNS: RegExp[] = [
  /\+\d{1,3}(?:[\s.-]*\d){7,14}(?!\d)/g,
  /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g,
  /(?<!\d)\d{3}[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
  /(?<!\d)\d{10,11}(?!\d)/g,
];

export function luhnOk(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactCards(text: string): string {
  return text.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    return luhnOk(digits) ? '[CARD]' : match;
  });
}

function redactPhones(text: string): string {
  let out = text;
  for (const re of PHONE_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    out = out.replace(pattern, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15 ? '[PHONE]' : match;
    });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyTerms(text: string, terms: string[]): string {
  let out = text;
  for (const term of terms) {
    const pattern = /^[A-Za-z0-9]+$/.test(term)
      ? new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi')
      : new RegExp(escapeRegExp(term), 'gi');
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function redactExtraTerms(text: string, terms: string[]): string {
  const unique = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0))];
  if (unique.length === 0) return text;
  // Split on existing placeholders so user terms cannot rewrite [EMAIL]/[CARD]/…
  const pieces = text.split(PLACEHOLDER_RE);
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] ?? '';
    if (i % 2 === 1) out += `[${piece}]`;
    else out += applyTerms(piece, unique);
  }
  return out;
}

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text;
  out = out.replace(EMAIL_RE, '[EMAIL]');
  out = redactCards(out);
  out = out.replace(SSN_RE, '[SSN]');
  out = redactPhones(out);
  out = redactExtraTerms(out, opts.extraTerms ?? []);
  return out;
}

/** Redact both transcript text and speaker labels. */
export function redactSegment<T extends { text: string; speaker?: string }>(
  seg: T,
  opts: RedactOptions = {},
): T {
  return {
    ...seg,
    text: redact(seg.text, opts),
    speaker: seg.speaker !== undefined ? redact(seg.speaker, opts) : seg.speaker,
  };
}

export function redactSegments<T extends { text: string; speaker?: string }>(
  segments: T[],
  opts: RedactOptions = {},
): T[] {
  return segments.map((s) => redactSegment(s, opts));
}
