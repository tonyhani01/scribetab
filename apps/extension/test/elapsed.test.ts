import { describe, expect, it } from 'vitest';
import { formatElapsedMs } from '../utils/elapsed';

describe('formatElapsedMs', () => {
  it('formats zero and clamps negative elapsed time', () => {
    expect(formatElapsedMs(0)).toBe('00:00');
    expect(formatElapsedMs(-500)).toBe('00:00');
  });

  it('formats ordinary minutes and seconds', () => {
    expect(formatElapsedMs(2 * 60_000 + 7_000)).toBe('02:07');
  });

  it('keeps hours in the minute field for long recordings', () => {
    expect(formatElapsedMs(61 * 60_000 + 9_000)).toBe('61:09');
  });
});
