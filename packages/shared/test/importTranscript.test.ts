import { describe, expect, it } from 'vitest';
import { parseTranscriptFile } from '../src/importTranscript';

describe('parseTranscriptFile', () => {
  it('parses WEBVTT cues, timestamps, voice tags, speaker prefixes, and inline tags', () => {
    const content = `WEBVTT

intro cue
00:00:01.250 --> 00:00:03.500 align:start
<v Ada><b>Hello</b> team

00:04.000 --> 00:05.250
Ben: <i>Ship it.</i>
`;

    expect(parseTranscriptFile('weekly.sync.vtt', content)).toEqual({
      title: 'weekly.sync',
      segments: [
        { speaker: 'Ada', text: 'Hello team', startMs: 1_250, endMs: 3_500 },
        { speaker: 'Ben', text: 'Ship it.', startMs: 4_000, endMs: 5_250 },
      ],
    });
  });

  it('parses SRT blocks with comma timestamps and speaker prefixes', () => {
    const content = `1
00:00:00,500 --> 00:00:02,000
Ada: Hello
and welcome.

2
01:02:03,004 --> 01:02:04,005
No speaker here.
`;

    expect(parseTranscriptFile('standup.srt', content)).toEqual({
      title: 'standup',
      segments: [
        { speaker: 'Ada', text: 'Hello\nand welcome.', startMs: 500, endMs: 2_000 },
        { text: 'No speaker here.', startMs: 3_723_004, endMs: 3_724_005 },
      ],
    });
  });

  it('parses blank-line-separated text paragraphs with fallback timestamps', () => {
    const content = `Ada: First paragraph.
Still the first paragraph.

Second paragraph.

Ben: Third paragraph.`;

    expect(parseTranscriptFile('notes.txt', content)).toEqual({
      title: 'notes',
      segments: [
        {
          speaker: 'Ada',
          text: 'First paragraph.\nStill the first paragraph.',
          startMs: 0,
          endMs: 1_000,
        },
        { text: 'Second paragraph.', startMs: 1_000, endMs: 2_000 },
        { speaker: 'Ben', text: 'Third paragraph.', startMs: 2_000, endMs: 3_000 },
      ],
    });
  });

  it('parses the native ScribeTab transcript JSON shape and keeps only import fields', () => {
    const content = JSON.stringify({
      session: {
        id: 'session-1',
        title: 'Title stored in the session',
        startedAt: '2026-08-31T10:00:00.000Z',
        platform: 'meet',
        status: 'complete',
      },
      segments: [
        {
          id: 'segment-1',
          sessionId: 'session-1',
          startMs: 250,
          endMs: 1_500,
          speaker: 'Ada',
          text: 'From ScribeTab.',
          source: 'audio',
        },
        {
          id: 'segment-2',
          sessionId: 'session-1',
          startMs: 1_500,
          endMs: 2_000,
          text: 'No named speaker.',
          source: 'captions',
        },
      ],
    });

    expect(parseTranscriptFile('native-export.json', content)).toEqual({
      title: 'native-export',
      segments: [
        { speaker: 'Ada', text: 'From ScribeTab.', startMs: 250, endMs: 1_500 },
        { text: 'No named speaker.', startMs: 1_500, endMs: 2_000 },
      ],
    });
  });

  it('caps imported transcripts at 20,000 segments', () => {
    const content = Array.from({ length: 20_001 }, (_, index) => `Line ${index}`).join('\n\n');
    const result = parseTranscriptFile('large.txt', content);

    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.segments).toHaveLength(20_000);
    expect(result.segments.at(-1)).toEqual({
      text: 'Line 19999',
      startMs: 19_999_000,
      endMs: 20_000_000,
    });
  });

  it.each([
    ['unsupported extension', 'meeting.docx', 'text'],
    ['invalid WEBVTT', 'meeting.vtt', 'not a WEBVTT file'],
    ['invalid SRT', 'meeting.srt', 'not an SRT file'],
    ['empty text', 'meeting.txt', '   \n\n'],
    ['invalid JSON syntax', 'meeting.json', '{broken'],
    ['invalid ScribeTab JSON shape', 'meeting.json', '{"session":{},"segments":{}}'],
  ])('returns an error for %s', (_case, name, content) => {
    expect(parseTranscriptFile(name, content)).toEqual({ error: expect.any(String) });
  });
});
