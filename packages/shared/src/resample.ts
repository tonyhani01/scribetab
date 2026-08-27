/**
 * Linear-interpolate mono PCM to a new sample rate.
 * Deterministic, no windowing — intended for speech STT and a 16 kHz Opus encoder.
 *
 * Per-chunk independent resampling drifts <1 sample per chunk for non-integer
 * ratios (negligible for our 12–20 s chunks).
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return new Float32Array(input);
  if (input.length === 0) return new Float32Array(0);

  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);

  const ratio = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.min(Math.floor(srcPos), last);
    const i1 = Math.min(i0 + 1, last);
    const frac = srcPos - Math.floor(srcPos);
    const a = input[i0] ?? 0;
    const b = input[i1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
