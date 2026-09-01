import { describe, expect, it, vi } from 'vitest';
import { queryMicPermission, requestMicAccess } from '../utils/micPermission';

function fakeNavigator(overrides: object): Navigator {
  return overrides as unknown as Navigator;
}

describe('queryMicPermission', () => {
  it('maps the permissions API state through', async () => {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      const query = vi.fn().mockResolvedValue({ state });
      const nav = fakeNavigator({ permissions: { query } });

      expect(await queryMicPermission(nav)).toBe(state);
      expect(query).toHaveBeenCalledWith({ name: 'microphone' });
    }
  });

  it('returns unsupported when the permissions API is missing', async () => {
    expect(await queryMicPermission(fakeNavigator({}))).toBe('unsupported');
  });

  it('returns unsupported when the query rejects', async () => {
    const query = vi.fn().mockRejectedValue(new Error('unsupported permission'));
    const nav = fakeNavigator({ permissions: { query } });

    expect(await queryMicPermission(nav)).toBe('unsupported');
  });
});

describe('requestMicAccess', () => {
  it('stops every track and returns granted on success', async () => {
    const stops = [vi.fn(), vi.fn()];
    const stream = {
      getTracks: () => stops.map((stop) => ({ stop })),
    };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const nav = fakeNavigator({ mediaDevices: { getUserMedia } });

    expect(await requestMicAccess(nav)).toBe('granted');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it('returns denied when getUserMedia rejects', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const nav = fakeNavigator({ mediaDevices: { getUserMedia } });

    expect(await requestMicAccess(nav)).toBe('denied');
  });

  it('returns denied when mediaDevices is missing', async () => {
    expect(await requestMicAccess(fakeNavigator({}))).toBe('denied');
  });
});
