import { describe, expect, it } from 'vitest';
import {
  reconcileDiarization,
  shouldRunWholeFileDiarization,
  wholeFileDiarizationSupported,
} from '../src/diarization.js';
import type { TranscriptSegment } from '../src/types.js';

function seg(p: Partial<TranscriptSegment> & { id: string; startMs: number; endMs: number }): TranscriptSegment {
  return { sessionId: 's', text: 'hi', source: 'audio', ...p };
}

describe('reconcileDiarization', () => {
  it('fills missing speakers by majority overlap', () => {
    const live = [seg({ id: 'a', startMs: 0, endMs: 1000 }), seg({ id: 'b', startMs: 1000, endMs: 2000 })];
    const out = reconcileDiarization(live, [
      { startMs: 0, endMs: 900, speaker: 'Speaker 1' },
      { startMs: 900, endMs: 2000, speaker: 'Speaker 2' },
    ]);
    expect(out.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('preserves existing caption speaker names', () => {
    const live = [seg({ id: 'a', startMs: 0, endMs: 1000, speaker: 'Ada' })];
    const out = reconcileDiarization(live, [{ startMs: 0, endMs: 1000, speaker: 'Speaker 1' }]);
    expect(out[0]!.speaker).toBe('Ada');
  });

  it('leaves non-overlapping segments untouched', () => {
    const live = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const out = reconcileDiarization(live, [{ startMs: 5000, endMs: 6000, speaker: 'Speaker 1' }]);
    expect(out[0]!.speaker).toBeUndefined();
  });

  it('ignores diarized entries without a speaker', () => {
    const live = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const out = reconcileDiarization(live, [{ startMs: 0, endMs: 1000, text: 'hi' }]);
    expect(out[0]!.speaker).toBeUndefined();
  });

  it('does not mutate inputs', () => {
    const live = [seg({ id: 'a', startMs: 0, endMs: 1000 })];
    const diarized = [{ startMs: 0, endMs: 1000, speaker: 'Speaker 1' }];
    const out = reconcileDiarization(live, diarized);
    expect(live[0]!.speaker).toBeUndefined();
    expect(out[0]).not.toBe(live[0]);
    expect(diarized[0]!.speaker).toBe('Speaker 1');
  });
});

describe('wholeFileDiarizationSupported', () => {
  it('is ElevenLabs-only — Google would need a Files API upload', () => {
    expect(wholeFileDiarizationSupported({ providerId: 'elevenlabs', diarize: true })).toBe(true);
    expect(wholeFileDiarizationSupported({ providerId: 'elevenlabs', diarize: undefined })).toBe(true);
    expect(wholeFileDiarizationSupported({ providerId: 'elevenlabs', diarize: false })).toBe(false);
    expect(wholeFileDiarizationSupported({ providerId: 'google', diarize: true })).toBe(false);
    expect(wholeFileDiarizationSupported({ providerId: 'openai', diarize: true })).toBe(false);
  });
});

describe('shouldRunWholeFileDiarization', () => {
  it('runs for elevenlabs over one chunk', () => {
    expect(shouldRunWholeFileDiarization({ providerId: 'elevenlabs', diarize: true, audioSeconds: 60 })).toBe(true);
    expect(shouldRunWholeFileDiarization({ providerId: 'elevenlabs', diarize: undefined, audioSeconds: 60 })).toBe(true);
  });

  it('skips google, other providers, diarize off, and short meetings', () => {
    expect(shouldRunWholeFileDiarization({ providerId: 'google', diarize: true, audioSeconds: 60 })).toBe(false);
    expect(shouldRunWholeFileDiarization({ providerId: 'openai', diarize: true, audioSeconds: 60 })).toBe(false);
    expect(shouldRunWholeFileDiarization({ providerId: 'elevenlabs', diarize: false, audioSeconds: 60 })).toBe(false);
    expect(shouldRunWholeFileDiarization({ providerId: 'elevenlabs', diarize: true, audioSeconds: 20 })).toBe(false);
    expect(shouldRunWholeFileDiarization({ providerId: 'elevenlabs', diarize: true, audioSeconds: 0 })).toBe(false);
  });
});
