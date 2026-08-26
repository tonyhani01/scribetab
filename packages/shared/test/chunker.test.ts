import { describe, it, expect } from 'vitest';
import { SilenceChunker } from '../src/chunker';

const SR = 16000;
const opts = {
  sampleRate: SR,
  targetSeconds: 2,
  maxSeconds: 4,
  silenceThreshold: 0.01,
  minSilenceMs: 300,
};

function tone(seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  return out;
}
const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));

/** Feed audio in worklet-sized frames (128 samples); collect emitted chunks. */
function feed(chunker: SilenceChunker, audio: Float32Array): Float32Array[] {
  const chunks: Float32Array[] = [];
  for (let i = 0; i < audio.length; i += 128) {
    const c = chunker.push(audio.subarray(i, Math.min(i + 128, audio.length)));
    if (c) chunks.push(c);
  }
  return chunks;
}

describe('SilenceChunker', () => {
  it('does not cut before targetSeconds', () => {
    const chunker = new SilenceChunker(opts);
    expect(feed(chunker, tone(1.5))).toHaveLength(0);
  });

  it('cuts at the first sustained silence after targetSeconds', () => {
    const chunker = new SilenceChunker(opts);
    const audio = new Float32Array([...tone(2.5), ...silence(0.5), ...tone(1)]);
    const chunks = feed(chunker, audio);
    expect(chunks).toHaveLength(1);
    const durSec = chunks[0]!.length / SR;
    expect(durSec).toBeGreaterThanOrEqual(2.5); // includes the speech
    expect(durSec).toBeLessThan(3.2);           // cut inside the silence window
  });

  it('hard-cuts at maxSeconds when there is no silence', () => {
    const chunker = new SilenceChunker(opts);
    const chunks = feed(chunker, tone(5));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length / SR).toBeCloseTo(4, 1);
  });

  it('flush returns the remainder and then nothing', () => {
    const chunker = new SilenceChunker(opts);
    feed(chunker, tone(1));
    const rest = chunker.flush();
    expect(rest).not.toBeNull();
    expect(rest!.length / SR).toBeCloseTo(1, 1);
    expect(chunker.flush()).toBeNull();
  });

  it('works with production defaults at 48 kHz', () => {
    const sr = 48000;
    const chunker = new SilenceChunker({
      sampleRate: sr,
      targetSeconds: 45,
      maxSeconds: 60,
      silenceThreshold: 0.01,
      minSilenceMs: 300,
    });
    // 61s of tone at 48 kHz must hard-cut exactly once at ~60s.
    const out = new Float32Array(Math.round(61 * sr));
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const chunks: Float32Array[] = [];
    for (let i = 0; i < out.length; i += 128) {
      const c = chunker.push(out.subarray(i, Math.min(i + 128, out.length)));
      if (c) chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length / sr).toBeCloseTo(60, 0);
  });
});
