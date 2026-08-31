import { describe, expect, it } from 'vitest';
import { distinctSpeakers, type TranscriptSegment } from '@scribetab/shared';
import {
  renameStoredSpeaker,
  applyStoredSpeakerNames,
  speakerMergeTarget,
} from '../utils/speakerRename';

const row = (speaker: string, id = speaker): TranscriptSegment => ({
  id,
  sessionId: 's1',
  startMs: 0,
  endMs: 100,
  text: 'hello',
  speaker,
  source: 'captions',
});

const twoSpeakers = (): TranscriptSegment[] => [row('Ann', 'a1'), row('Ann', 'a2'), row('Bob', 'b1')];

describe('speaker rename state', () => {
  it('keeps the original alias while repeated renames update stored rows', () => {
    const first = renameStoredSpeaker([row('Alice')], {}, 'Alice', 'Bob');
    const second = renameStoredSpeaker(first.segments, first.speakerNames, 'Alice', 'Carol');
    expect(second.segments[0]?.speaker).toBe('Carol');
    expect(second.speakerNames).toEqual({ Alice: 'Carol' });
  });

  it('applies aliases to newly persisted raw speaker rows', () => {
    expect(applyStoredSpeakerNames([row('Alice')], { Alice: 'Carol' })[0]?.speaker).toBe('Carol');
  });

  it('leaves rows untouched when the new name is blank', () => {
    const res = renameStoredSpeaker([row('Ann')], { Alice: 'Ann' }, 'Alice', '   ');
    expect(res.speakerNames).toEqual({ Alice: 'Ann' });
    expect(res.segments[0]?.speaker).toBe('Ann');
  });
});

describe('speaker merge on rename collision', () => {
  it('reports the display name a rename would collapse into', () => {
    expect(speakerMergeTarget(twoSpeakers(), { Alice: 'Ann', Bruno: 'Bob' }, 'Alice', 'Bob')).toBe('Bob');
    // A never-renamed speaker is identified by the label its rows already carry.
    expect(speakerMergeTarget(twoSpeakers(), { Alice: 'Ann' }, 'Alice', 'Bob')).toBe('Bob');
  });

  it('is not a merge when the name is new, unchanged, or only a stale map entry', () => {
    expect(speakerMergeTarget(twoSpeakers(), { Alice: 'Ann', Bruno: 'Bob' }, 'Alice', 'Cara')).toBeNull();
    expect(speakerMergeTarget(twoSpeakers(), { Alice: 'Ann' }, 'Alice', 'Ann')).toBeNull();
    expect(speakerMergeTarget([row('Ann')], { Alice: 'Ann', Bruno: 'Bob' }, 'Alice', 'Bob')).toBeNull();
  });

  it('points both original aliases at the existing name and moves the merged rows', () => {
    const res = renameStoredSpeaker(twoSpeakers(), { Alice: 'Ann', Bruno: 'Bob' }, 'Alice', 'Bob');
    expect(res.speakerNames).toEqual({ Alice: 'Bob', Bruno: 'Bob' });
    expect(res.segments.map((s) => s.speaker)).toEqual(['Bob', 'Bob', 'Bob']);
    // The speaker list is built from display names, so the merge shows one chip.
    expect(distinctSpeakers(applyStoredSpeakerNames(res.segments, res.speakerNames))).toEqual(['Bob']);
  });

  it('keeps merged speakers merged when the shared name is renamed again', () => {
    const res = renameStoredSpeaker(
      [row('Bob', 'a1'), row('Bob', 'b1')],
      { Alice: 'Bob', Bruno: 'Bob' },
      'Alice',
      'Bobby',
    );
    expect(res.speakerNames).toEqual({ Alice: 'Bobby', Bruno: 'Bobby' });
    expect(res.segments.map((s) => s.speaker)).toEqual(['Bobby', 'Bobby']);
  });

  it('collapses speakers by display name when rows keep their original keys', () => {
    expect(
      distinctSpeakers(
        applyStoredSpeakerNames([row('Alice', 'a1'), row('Bruno', 'b1'), row('Cara', 'c1')], {
          Alice: 'Bob',
          Bruno: 'Bob',
        }),
      ),
    ).toEqual(['Bob', 'Cara']);
  });
});
