import { describe, expect, it } from 'vitest';
import type { HighlightMoment, TranscriptSegment } from '../src/types';
import {
  HIGHLIGHT_KIND_EMOJI,
  HIGHLIGHT_KINDS,
  applySpeakerNames,
  distinctSpeakers,
  highlightKindEmoji,
  highlightsWithContext,
  normalizeSpeakerNames,
} from '../src/speakers';

const segment = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: 'seg',
  sessionId: 's1',
  startMs: 0,
  endMs: 1000,
  text: 'hello',
  speaker: 'Ada',
  source: 'captions',
  ...over,
});

describe('speaker helpers', () => {
  it('returns renamed copies and ignores empty or whitespace names', () => {
    const source = [segment(), segment({ id: 'blank', speaker: 'Bo' }), segment({ id: 'none', speaker: undefined })];
    const renamed = applySpeakerNames(source, { Ada: '  Alice  ', Bo: '   ' });
    expect(renamed).toEqual([
      { ...source[0], speaker: 'Alice' },
      source[1],
      source[2],
    ]);
    expect(renamed).not.toBe(source);
    expect(renamed[0]).not.toBe(source[0]);
  });

  it('orders distinct speakers by descending segment count then alphabetically', () => {
    expect(distinctSpeakers([
      segment({ id: '1', speaker: 'Cara' }),
      segment({ id: '2', speaker: 'Ada' }),
      segment({ id: '3', speaker: 'Ada' }),
      segment({ id: '4', speaker: '  Bob ' }),
      segment({ id: '5', speaker: 'Bob' }),
      segment({ id: '6', speaker: 'Bea' }),
    ])).toEqual(['Ada', 'Bob', 'Bea', 'Cara']);
  });

  it('trims names and drops empty or identity mappings', () => {
    expect(normalizeSpeakerNames({ ' Ada ': ' Alice ', Bob: '  ', Cy: 'Cy', '  ': 'x' })).toEqual({
      Ada: 'Alice',
    });
  });

  it('returns ordered highlights with the nearest segment', () => {
    const highlights: HighlightMoment[] = [
      { id: 'late', sessionId: 's1', startMs: 9_000, createdAt: 't' },
      { id: 'early', sessionId: 's1', startMs: 1_100, label: 'note', createdAt: 't' },
    ];
    const out = highlightsWithContext(highlights, [
      segment({ id: 'far', startMs: 8_000, endMs: 9_000, text: 'far' }),
      segment({ id: 'near', startMs: 1_000, endMs: 2_000, text: 'near' }),
    ]);
    expect(out.map((x) => [x.highlight.id, x.segment?.id])).toEqual([
      ['early', 'near'],
      ['late', 'far'],
    ]);
  });

  it('renders private notes with the 📝 prefix used by exports', () => {
    expect(HIGHLIGHT_KINDS).toContain('note');
    expect(HIGHLIGHT_KIND_EMOJI.note).toBe('📝');
    expect(highlightKindEmoji('note')).toBe('📝');
  });
});
