import { describe, expect, it } from 'vitest';
import { isCapturableUrl, isMeetingPlatform, platformFromUrl, titleFromTab } from '../utils/platform';

describe('platformFromUrl', () => {
  it('maps known meeting hosts', () => {
    expect(platformFromUrl('https://meet.google.com/abc')).toBe('meet');
    expect(platformFromUrl('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(platformFromUrl('https://foo.teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(platformFromUrl('https://notteams.microsoft.com/l/meetup-join/x')).toBe('other');
    expect(platformFromUrl('https://teams.microsoft.com.evil.example/x')).toBe('other');
    expect(platformFromUrl('https://us02web.zoom.us/j/1')).toBe('zoom');
    expect(platformFromUrl('https://www.youtube.com/watch?v=1')).toBe('youtube');
    expect(platformFromUrl('https://example.com/call')).toBe('other');
    expect(platformFromUrl(undefined)).toBe('other');
  });
});

describe('titleFromTab', () => {
  it('falls back to Untitled meeting', () => {
    expect(titleFromTab({ title: '  Weekly  ' })).toBe('Weekly');
    expect(titleFromTab({ title: '' })).toBe('Untitled meeting');
    expect(titleFromTab(undefined)).toBe('Untitled meeting');
  });
});

describe('isMeetingPlatform', () => {
  it('is true only for known meeting hosts', () => {
    expect(isMeetingPlatform('https://meet.google.com/abc')).toBe(true);
    expect(isMeetingPlatform('https://example.com')).toBe(false);
  });
});

describe('isCapturableUrl', () => {
  it('rejects browser UI, extensions, and the Web Store', () => {
    expect(isCapturableUrl(undefined)).toBe(false);
    expect(isCapturableUrl('chrome://newtab/')).toBe(false);
    expect(isCapturableUrl('chrome-extension://abc/popup.html')).toBe(false);
    expect(isCapturableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isCapturableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isCapturableUrl('https://www.youtube.com/watch?v=1')).toBe(true);
  });
});
