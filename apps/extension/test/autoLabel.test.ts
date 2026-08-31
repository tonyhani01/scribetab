import { describe, expect, it } from 'vitest';
import { computeLabels } from '../utils/autoLabel';

const HOUR_MS = 60 * 60 * 1000;

const input = (over: Partial<Parameters<typeof computeLabels>[0]> = {}) => ({
  title: 'Standup',
  durationMs: 10 * 60 * 1000,
  speakerCount: 3,
  ...over,
});

describe('computeLabels', () => {
  it('labels exactly two speakers as 1:1', () => {
    expect(computeLabels(input({ speakerCount: 2 }))).toEqual(['1:1']);
    expect(computeLabels(input({ speakerCount: 1 }))).toEqual([]);
    expect(computeLabels(input({ speakerCount: 3 }))).toEqual([]);
    expect(computeLabels(input({ speakerCount: 0 }))).toEqual([]);
  });

  it('labels strictly over 60 minutes as Long', () => {
    expect(computeLabels(input({ durationMs: HOUR_MS + 1 }))).toEqual(['Long']);
    expect(computeLabels(input({ durationMs: HOUR_MS }))).toEqual([]);
    expect(computeLabels(input({ durationMs: 0 }))).toEqual([]);
    expect(computeLabels(input({ durationMs: -1 }))).toEqual([]);
  });

  it('labels meeting platforms by url', () => {
    expect(computeLabels(input({ url: 'https://meet.google.com/abc-def' }))).toEqual(['Meet']);
    expect(computeLabels(input({ url: 'https://us02web.zoom.us/j/1' }))).toEqual(['Zoom']);
    expect(computeLabels(input({ url: 'https://teams.microsoft.com/l/meetup-join/x' }))).toEqual([
      'Teams',
    ]);
    expect(computeLabels(input({ url: 'https://teams.live.com/meet/1' }))).toEqual(['Teams']);
  });

  it('labels YouTube by url host', () => {
    expect(computeLabels(input({ url: 'https://youtube.com/watch?v=1' }))).toEqual(['YouTube']);
    expect(computeLabels(input({ url: 'https://www.youtube.com/watch?v=1' }))).toEqual(['YouTube']);
    expect(computeLabels(input({ url: 'https://youtu.be/abc' }))).toEqual(['YouTube']);
  });

  it('does not label lookalike hosts', () => {
    expect(computeLabels(input({ url: 'https://notyoutube.com/watch?v=1' }))).toEqual([]);
    expect(computeLabels(input({ url: 'https://youtube.com.evil.example/watch?v=1' }))).toEqual([]);
    expect(computeLabels(input({ url: 'https://example.com/call' }))).toEqual([]);
  });

  it('does not label missing or malformed urls', () => {
    expect(computeLabels(input({ url: undefined }))).toEqual([]);
    expect(computeLabels(input({ url: '' }))).toEqual([]);
    expect(computeLabels(input({ url: 'not a url' }))).toEqual([]);
  });

  it('combines labels in a fixed order', () => {
    expect(
      computeLabels(
        input({
          title: 'Long 1:1',
          durationMs: 90 * 60 * 1000,
          speakerCount: 2,
          url: 'https://meet.google.com/abc',
        }),
      ),
    ).toEqual(['1:1', 'Long', 'Meet']);
  });
});
