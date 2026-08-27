import { describe, expect, it } from 'vitest';
import { badgeText } from '../utils/actionBadge';

describe('badgeText', () => {
  it('invites capture on a known meeting tab', () => {
    expect(badgeText({ url: 'https://meet.google.com/abc', tabId: 1 })).toBe('REC?');
    expect(badgeText({ url: 'https://us02web.zoom.us/j/1', tabId: 1 })).toBe('REC?');
  });

  it('is blank on ordinary pages', () => {
    expect(badgeText({ url: 'https://example.com', tabId: 1 })).toBe('');
    expect(badgeText({ url: undefined, tabId: 1 })).toBe('');
  });

  it('shows REC on the captured tab while recording', () => {
    expect(
      badgeText({
        url: 'https://example.com',
        tabId: 7,
        captureState: 'recording',
        capturedTabId: 7,
      }),
    ).toBe('REC');
    expect(
      badgeText({
        url: 'https://meet.google.com/abc',
        tabId: 8,
        captureState: 'recording',
        capturedTabId: 7,
      }),
    ).toBe('REC?');
  });
});
