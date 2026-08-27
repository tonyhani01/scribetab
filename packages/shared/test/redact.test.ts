import { describe, expect, it } from 'vitest';
import { luhnOk, redact } from '../src/redact';

describe('luhnOk', () => {
  it('accepts a known Visa test number', () => {
    expect(luhnOk('4111111111111111')).toBe(true);
  });

  it('rejects a near-miss that fails the checksum', () => {
    expect(luhnOk('4111111111111112')).toBe(false);
  });

  it('rejects too-short digit strings', () => {
    expect(luhnOk('411111111111')).toBe(false);
  });
});

describe('redact', () => {
  it('replaces emails', () => {
    expect(redact('Reach ada@example.com please')).toBe('Reach [EMAIL] please');
  });

  it('leaves email near-misses alone', () => {
    expect(redact('not-an-email@ and foo@bar')).toBe('not-an-email@ and foo@bar');
  });

  it('replaces SSN patterns', () => {
    expect(redact('SSN 123-45-6789 on file')).toBe('SSN [SSN] on file');
  });

  it('does not treat undashed 9-digit numbers as SSNs', () => {
    expect(redact('id 123456789 stays')).toBe('id 123456789 stays');
  });

  it('replaces 10-digit phone numbers in common formats', () => {
    expect(redact('Call (415) 555-2671 or +1-415-555-2671')).toBe(
      'Call [PHONE] or [PHONE]',
    );
  });

  it('does not treat short numbers as phones', () => {
    expect(redact('extension 12345 or 555-1234')).toBe('extension 12345 or 555-1234');
  });

  it('replaces Luhn-valid cards including spaced/dashed forms', () => {
    expect(redact('card 4111-1111-1111-1111 billed')).toBe('card [CARD] billed');
    expect(redact('card 4111 1111 1111 1111 billed')).toBe('card [CARD] billed');
  });

  it('leaves Luhn-invalid 16-digit near-misses', () => {
    expect(redact('card 4111 1111 1111 1112 billed')).toBe(
      'card 4111 1111 1111 1112 billed',
    );
  });

  it('replaces user-defined terms as whole words', () => {
    expect(redact('Project Phoenix ships', { extraTerms: ['Phoenix'] })).toBe(
      'Project [REDACTED] ships',
    );
    expect(redact('Phoenician stays', { extraTerms: ['Phoenix'] })).toBe(
      'Phoenician stays',
    );
  });

  it('redacts overlapping PII in one pass (email before phone-like digits)', () => {
    const input = 'ada@example.com 4111-1111-1111-1111 123-45-6789 (415) 555-2671 Phoenix';
    expect(redact(input, { extraTerms: ['Phoenix'] })).toBe(
      '[EMAIL] [CARD] [SSN] [PHONE] [REDACTED]',
    );
  });

  it('is a no-op on clean text', () => {
    expect(redact('Hello team, next week we ship.')).toBe('Hello team, next week we ship.');
  });
});
