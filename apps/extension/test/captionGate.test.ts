import { describe, expect, it } from 'vitest';
import {
  acceptsCaptionEvents,
  captionsOnlyFallbackNotice,
  freezeCaptionsOnly,
  fusionWaitMs,
  isCaptionSenderAllowed,
} from '../utils/captionGate';

describe('isCaptionSenderAllowed', () => {
  it('accepts only the captured tab', () => {
    expect(isCaptionSenderAllowed(12, 12)).toBe(true);
    expect(isCaptionSenderAllowed(12, 99)).toBe(false);
    expect(isCaptionSenderAllowed(undefined, 12)).toBe(false);
    expect(isCaptionSenderAllowed(12, null)).toBe(false);
  });
});

describe('acceptsCaptionEvents', () => {
  it('accepts starting, recording, and stopping — not idle', () => {
    expect(acceptsCaptionEvents('starting')).toBe(true);
    expect(acceptsCaptionEvents('recording')).toBe(true);
    expect(acceptsCaptionEvents('stopping')).toBe(true);
    expect(acceptsCaptionEvents('idle')).toBe(false);
  });
});

describe('freezeCaptionsOnly', () => {
  it('is true only for Meet when the setting is on', () => {
    expect(freezeCaptionsOnly(true, 'meet')).toBe(true);
    expect(freezeCaptionsOnly(true, 'zoom')).toBe(false);
    expect(freezeCaptionsOnly(false, 'meet')).toBe(false);
  });
});

describe('captionsOnlyFallbackNotice', () => {
  it('surfaces a notice when captions-only is requested off Meet', () => {
    expect(captionsOnlyFallbackNotice(true, 'youtube', true)).toMatch(/Meet only/);
    expect(captionsOnlyFallbackNotice(true, 'meet', true)).toBeNull();
    expect(captionsOnlyFallbackNotice(false, 'zoom', true)).toBeNull();
  });
});

describe('fusionWaitMs', () => {
  it('runs immediately the first time, then throttles', () => {
    expect(fusionWaitMs(1000, 0, 2000)).toBe(0);
    expect(fusionWaitMs(2500, 1000, 2000)).toBe(500);
    expect(fusionWaitMs(3000, 1000, 2000)).toBe(0);
  });
});
