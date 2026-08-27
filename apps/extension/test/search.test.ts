import { describe, expect, it } from 'vitest';
import { createSegmentIndex, snippetAround } from '../utils/search';

describe('snippetAround', () => {
  it('windows text around the first query match', () => {
    const text = 'alpha beta gamma delta epsilon';
    expect(snippetAround(text, 'gamma', 4)).toBe('…eta gamma del…');
  });

  it('returns a prefix when the query is missing', () => {
    expect(snippetAround('hello world', 'zzz', 3)).toBe('hello ');
  });
});

describe('createSegmentIndex', () => {
  it('finds a segment by text and stores session id', () => {
    const idx = createSegmentIndex([
      { id: '1', sessionId: 's', startMs: 0, text: 'deploy the search index', sessionTitle: 'Standup' },
    ]);
    const hits = idx.search('search');
    expect(hits[0]?.id).toBe('1');
    expect(hits[0]?.sessionId).toBe('s');
  });
});
