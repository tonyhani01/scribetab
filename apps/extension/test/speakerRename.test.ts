import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@scribetab/shared';
import { renameStoredSpeaker, applyStoredSpeakerNames } from '../utils/speakerRename';

const row = (speaker: string, id = speaker): TranscriptSegment => ({
  id,
  sessionId: 's1',
  startMs: 0,
  endMs: 100,
  text: 'hello',
  speaker,
  source: 'captions',
});

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
});
