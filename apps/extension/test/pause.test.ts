import { describe, expect, it } from 'vitest';
import { badgeText, captureOriginAfterResume } from '../utils/actionBadge';
import { captureStateAfterToggle } from '../utils/messages';

describe('pause capture state', () => {
  it('round-trips recording through paused and back to recording', () => {
    const paused = captureStateAfterToggle('recording', true);
    expect(paused).toBe('paused');
    expect(captureStateAfterToggle(paused, false)).toBe('recording');
  });

  it('rejects pause and resume requests that do not apply to the current state', () => {
    expect(captureStateAfterToggle('paused', true)).toBeNull();
    expect(captureStateAfterToggle('recording', false)).toBeNull();
    expect(captureStateAfterToggle('idle', true)).toBeNull();
    expect(captureStateAfterToggle('stopping', false)).toBeNull();
  });

  it('shows the pause badge only on the captured tab', () => {
    expect(
      badgeText({
        url: 'https://example.com',
        tabId: 7,
        captureState: 'paused',
        capturedTabId: 7,
      }),
    ).toBe('⏸');
    expect(
      badgeText({
        url: 'https://example.com',
        tabId: 8,
        captureState: 'paused',
        capturedTabId: 7,
      }),
    ).toBe('');
  });

  it('moves the effective capture origin forward by the paused interval', () => {
    expect(captureOriginAfterResume(1_000, 11_000, 71_000)).toBe(61_000);
  });
});
