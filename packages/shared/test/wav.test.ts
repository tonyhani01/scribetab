import { describe, it, expect } from 'vitest';
import { encodeWav, wavHeader } from '../src/wav';

describe('wavHeader', () => {
  it('writes a valid 16-bit mono RIFF/WAVE header', () => {
    const buf = wavHeader(48000 * 2, 48000); // 1s of audio
    const view = new DataView(buf);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(buf.byteLength).toBe(44);
    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 48000 * 2);
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);        // mono
    expect(view.getUint32(24, true)).toBe(48000);    // sample rate
    expect(view.getUint16(34, true)).toBe(16);       // bits per sample
    expect(view.getUint32(40, true)).toBe(48000 * 2); // data byte length
  });
});

describe('encodeWav', () => {
  it('produces header + samples', () => {
    const samples = new Float32Array(48000);
    const buf = encodeWav(samples, 48000);
    expect(buf.byteLength).toBe(44 + 48000 * 2);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));
    expect(ascii(0, 4)).toBe('RIFF');
  });

  it('clamps and converts float samples to int16', () => {
    const samples = new Float32Array([0, 1, -1, 2, -2]); // 2/-2 must clamp
    const buf = encodeWav(samples, 16000);
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32768);
  });
});
