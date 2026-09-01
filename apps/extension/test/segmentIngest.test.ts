import { describe, expect, it } from 'vitest';
import {
  normalizeVocabReplacements,
  prepareFusedSegmentsForStorage,
  prepareSegmentsForStorage,
} from '../utils/segmentIngest';

const segment = {
  id: 'seg-1',
  sessionId: 'session-1',
  startMs: 0,
  endMs: 1000,
  text: 'Teh launch is teh priority',
  speaker: 'Teh Lead',
  source: 'audio' as const,
};

describe('prepareSegmentsForStorage', () => {
  it('applies vocabulary replacements when at-rest redaction is off', () => {
    const stored = prepareSegmentsForStorage([segment], null, [['teh', 'the']]);

    expect(stored[0]).toEqual({
      ...segment,
      text: 'The launch is the priority',
    });
    expect(segment.text).toBe('Teh launch is teh priority');
  });

  it('redacts before applying replacements and keeps speaker labels out of corrections', () => {
    const stored = prepareSegmentsForStorage(
      [segment],
      { extraTerms: ['teh'] },
      [['teh', 'the']],
    );

    expect(stored[0]?.text).toBe('[REDACTED] launch is [REDACTED] priority');
    expect(stored[0]?.speaker).toBe('[REDACTED] Lead');
  });
});

describe('prepareFusedSegmentsForStorage', () => {
  it('does not reapply non-idempotent corrections to text prepared at initial ingest', () => {
    const replacements: [string, string][] = [
      ['foo', 'bar'],
      ['baz', 'foo'],
    ];
    const initiallyStored = prepareSegmentsForStorage(
      [{ ...segment, text: 'baz' }],
      null,
      replacements,
    );

    const fused = prepareFusedSegmentsForStorage(
      [{ ...initiallyStored[0]!, speaker: 'Ada 4155552671' }],
      { extraTerms: ['Ada'] },
    );

    expect(initiallyStored[0]?.text).toBe('foo');
    expect(fused[0]?.text).toBe('foo');
    expect(fused[0]?.speaker).toBe('[REDACTED] [PHONE]');
  });
});

describe('normalizeVocabReplacements', () => {
  it('keeps valid capture snapshots and drops corrupted storage entries', () => {
    expect(normalizeVocabReplacements([
      ['teh', 'the'],
      ['um', ''],
      ['missing-right'],
      [42, 'number'],
      null,
    ])).toEqual([
      ['teh', 'the'],
      ['um', ''],
    ]);
    expect(normalizeVocabReplacements('teh=>the')).toEqual([]);
  });
});
