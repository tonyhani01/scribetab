/**
 * Text-only PII redaction.
 *
 * Scope (honest): this pass runs on transcript *text* — before an LLM call,
 * and before IndexedDB storage when "redact at rest" is enabled. Raw audio
 * sent to an STT provider cannot be pre-redacted. Retained WAV files are
 * likewise unredacted.
 */

export interface RedactOptions {
  extraTerms?: string[];
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// 10-digit NANP, optional +1 / parens / separators. Not 7-digit locals (too many false hits).
const PHONE_RE =
  /(?<![\dA-Z])(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}(?![\dA-Z])/gi;
// 13–19 digits with optional spaces/dashes; Luhn-checked after strip.
const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ \-]*?){13,19}(?!\d)/g;

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactExtraTerms(text: string, terms: string[]): string {
  let out = text;
  const unique = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0))];
  for (const term of unique) {
    const pattern = /^[A-Za-z0-9]+$/.test(term)
      ? new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi')
      : new RegExp(escapeRegExp(term), 'gi');
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text;
  out = out.replace(EMAIL_RE, '[EMAIL]');
  out = redactCards(out);
  out = out.replace(SSN_RE, '[SSN]');
  out = out.replace(PHONE_RE, '[PHONE]');
  out = redactExtraTerms(out, opts.extraTerms ?? []);
  return out;
}
