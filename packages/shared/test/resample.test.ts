import { describe, it, expect } from 'vitest';
import { resampleLinear } from '../src/resample';

describe('resampleLinear', () => {
  it('returns a copy when rates match', () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    const out = resampleLinear(input, 16000, 16000);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('returns empty output for empty input', () => {
    const out = resampleLinear(new Float32Array(), 48000, 16000);
    expect(out.length).toBe(0);
  });

  it('downsamples 3:1 against hand-computed values', () => {
    // positions 0 and 3 in [0,1,2,3,4,5]
    const input = new Float32Array([0, 1, 2, 3, 4, 5]);
    const out = resampleLinear(input, 3, 1);
    expect(Array.from(out)).toEqual([0, 3]);
  });

  it('interpolates a 3:2 ratio by hand', () => {
    // outLen = round(3*2/3) = 2; src positions 0 and 1.5 → 0 and lerp(10,20,0.5)=15
    const input = new Float32Array([0, 10, 20]);
    const out = resampleLinear(input, 3, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(15);
  });

  it('downsamples 48000 → 16000 at exact 3:1 sample positions', () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = resampleLinear(input, 48000, 16000);
    expect(out.length).toBe(160);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(3);
    expect(out[2]).toBe(6);
  });

  it('maps 44100 → 16000 length by round(n * to/from)', () => {
    const input = new Float32Array(441);
    const out = resampleLinear(input, 44100, 16000);
    expect(out.length).toBe(160);
  });

  it('yields one sample for a single-sample input', () => {
    const out = resampleLinear(new Float32Array([0.5]), 48000, 16000);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0.5);
  });

  it('upsamples 16 kHz → 48 kHz length and endpoints', () => {
    const input = new Float32Array([0, 1]);
    const out = resampleLinear(input, 16000, 48000);
    expect(out.length).toBe(6);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(1);
  });
});
