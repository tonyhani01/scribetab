import { describe, expect, it } from 'vitest';
import { reduceTeamsCaptionRows } from '../utils/teamsSelectors';

describe('reduceTeamsCaptionRows', () => {
  it('normalizes Teams rows and removes the author label from caption text', () => {
    expect(
      reduceTeamsCaptionRows([
        { author: '  Ada  ', text: ' Ada   Hello   team ' },
        { author: 'Bob', text: 'Bob: Good morning' },
      ]),
    ).toEqual([
      { speaker: 'Ada', text: 'Hello team' },
      { speaker: 'Bob', text: 'Good morning' },
    ]);
  });

  it('uses Speaker when Teams omits the author element', () => {
    expect(reduceTeamsCaptionRows([{ author: null, text: ' Welcome everyone ' }])).toEqual([
      { speaker: 'Speaker', text: 'Welcome everyone' },
    ]);
  });

  it('drops empty and author-only rows', () => {
    expect(
      reduceTeamsCaptionRows([
        { author: 'Ada', text: 'Ada' },
        { author: null, text: '   ' },
      ]),
    ).toEqual([]);
  });
});
