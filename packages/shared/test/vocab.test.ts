import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_CHARS,
  applyReplacements,
  applyReplacementsToSegments,
  hintsToPrompt,
  parseVocab,
} from '../src/vocab';

describe('parseVocab', () => {
  it('treats plain lines as provider hints, in order', () => {
    expect(parseVocab(['Kubernetes', '  ', 'AcmeCorp', 'β-hydroxy'])).toEqual({
      hints: ['Kubernetes', 'AcmeCorp', 'β-hydroxy'],
      replacements: [],
    });
  });

  it('parses wrong=>right pairs, trimming both sides', () => {
    const v = parseVocab([' teh   =>   the ', 'Kubertes=>Kubernetes']);
    expect(v.hints).toEqual([]);
    expect(v.replacements).toEqual([
      ['teh', 'the'],
      ['Kubertes', 'Kubernetes'],
    ]);
  });

  it('splits on the first arrow only, so the replacement can contain one', () => {
    expect(parseVocab(['acme=>acme=>beta']).replacements).toEqual([['acme', 'acme=>beta']]);
  });

  it('keeps an empty right side (delete the term) and drops pairs with no left side', () => {
    const v = parseVocab(['um=>', '=>the', '']);
    expect(v.replacements).toEqual([['um', '']]);
    expect(v.hints).toEqual([]);
  });

  it('mixes hints and pairs, dedupes hints, and survives non-string lines', () => {
    const v = parseVocab([
      'Kubernetes',
      'Kubernetes',
      'teh=>the',
      'AcmeCorp',
      42 as unknown as string,
      undefined as unknown as string,
    ]);
    expect(v.hints).toEqual(['Kubernetes', 'AcmeCorp']);
    expect(v.replacements).toEqual([['teh', 'the']]);
  });

  it('returns an empty parse for a non-array', () => {
    expect(parseVocab(undefined as unknown as string[])).toEqual({ hints: [], replacements: [] });
  });
});

describe('hintsToPrompt', () => {
  it('joins hints with single spaces and ignores blanks', () => {
    expect(hintsToPrompt(['Kubernetes', '  ', 'AcmeCorp'])).toBe('Kubernetes AcmeCorp');
  });

  it('is empty when there are no hints', () => {
    expect(hintsToPrompt([])).toBe('');
  });

  it('drops trailing terms that do not fit the budget instead of truncating one', () => {
    const prompt = hintsToPrompt(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(500)], 100);
    expect(prompt).toBe(`${'a'.repeat(30)} ${'b'.repeat(30)}`);
    expect(prompt.length).toBeLessThanOrEqual(100);
  });

  it('defaults to the Whisper prompt budget', () => {
    expect(hintsToPrompt(['x'.repeat(MAX_PROMPT_CHARS + 1)])).toBe('');
    expect(hintsToPrompt(['x'.repeat(MAX_PROMPT_CHARS)]).length).toBe(MAX_PROMPT_CHARS);
  });
});

const R: [string, string][] = [['teh', 'the'], ['AcmeCorp', 'Acme Corp']];

describe('applyReplacements', () => {
  it('replaces whole words only', () => {
    expect(applyReplacements('teh cat', R)).toBe('the cat');
    expect(applyReplacements('thematic teething Tate', R)).toBe('thematic teething Tate');
    expect(applyReplacements('the AcmeCorpness', R)).toBe('the AcmeCorpness');
  });

  it('replaces every occurrence on both sides of punctuation', () => {
    expect(applyReplacements('teh, and then teh.', R)).toBe('the, and then the.');
    expect(applyReplacements('(teh) "teh" (teh)', R)).toBe('(the) "the" (the)');
  });

  it('preserves the matched leading case', () => {
    expect(applyReplacements('Teh issue', R)).toBe('The issue');
    expect(applyReplacements('TEH ISSUE', R)).toBe('The ISSUE');
    expect(applyReplacements('teh issue', R)).toBe('the issue');
  });

  it('leaves an already-capitalised replacement alone and handles multi-word targets', () => {
    expect(applyReplacements('meet at AcmeCorp', [R[1]!])).toBe('meet at Acme Corp');
    expect(applyReplacements('at acmecorp', [['acmecorp', 'Acme Corp']])).toBe('at Acme Corp');
    expect(applyReplacements('at AcmeCorp', [['acmecorp', 'Acme Corp']])).toBe('at Acme Corp');
  });

  it('is case-insensitive for unicode terms and boundaries', () => {
    expect(applyReplacements('Ångström is small', [['ångström', 'Angstrom']])).toBe('Angstrom is small');
    expect(applyReplacements('Ångström', [['ng', 'NG']])).toBe('Ångström');
  });

  it('matches punctuated terms without a word-char edge', () => {
    expect(applyReplacements('written in c++ and dc++', [['c++', 'C++']])).toBe('written in C++ and dc++');
    expect(applyReplacements('use acme.io now', [['acme.io', 'AcmeCorp']])).toBe('use AcmeCorp now');
  });

  it('treats $ in the replacement as literal text', () => {
    expect(applyReplacements('cost in usd', [['usd', '$1']])).toBe('cost in $1');
  });

  it('deletes a term when the right side is empty', () => {
    expect(applyReplacements('so yeah um next', [['um', '']])).toBe('so yeah  next');
  });

  it('applies pairs in order', () => {
    expect(applyReplacements('Kubertes', [['kubertes', 'Kubernetes'], ['kubernetes', 'K8s']])).toBe('K8s');
  });

  it('is a no-op for empty text, empty rules, and malformed rules', () => {
    expect(applyReplacements('teh', [])).toBe('teh');
    expect(applyReplacements('', R)).toBe('');
    expect(applyReplacements('hi', [null as unknown as [string, string]])).toBe('hi');
    expect(applyReplacements('hi', [['', 'x']] as [string, string][])).toBe('hi');
    expect(applyReplacements('hi', 'nope' as unknown as [string, string][])).toBe('hi');
  });

  it('never rewrites redaction placeholders', () => {
    expect(applyReplacements('mail [EMAIL] now', [['e', 'E']])).toBe('mail [EMAIL] now');
  });
});

describe('applyReplacementsToSegments', () => {
  it('rewrites text and keeps ids, offsets and speakers intact', () => {
    const segs = [
      { id: 'a', sessionId: 's', startMs: 0, endMs: 10, text: 'teh AcmeCorp', speaker: 'Teh Boss', source: 'audio' as const },
      { id: 'b', sessionId: 's', startMs: 10, endMs: 20, text: 'clean', source: 'audio' as const },
    ];
    expect(applyReplacementsToSegments(segs, R)).toEqual([
      { id: 'a', sessionId: 's', startMs: 0, endMs: 10, text: 'the Acme Corp', speaker: 'Teh Boss', source: 'audio' },
      { id: 'b', sessionId: 's', startMs: 10, endMs: 20, text: 'clean', source: 'audio' },
    ]);
    expect(segs[0]!.text).toBe('teh AcmeCorp'); // input not mutated
  });

  it('returns the same array when there is nothing to apply', () => {
    const segs = [{ text: 'teh' }];
    expect(applyReplacementsToSegments(segs, [])).toBe(segs);
  });
});

