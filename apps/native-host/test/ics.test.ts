import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ICS_CACHE_TTL_MS,
  clearIcsCache,
  fetchUpcomingEvents,
  filterEventWindow,
  matchUpcomingEvent,
  parseIcs,
  parseIcsDateTime,
  readBodyCapped,
  unescapeIcsText,
  unfoldLines,
} from '../src/ics.ts';

// 2026-09-01 is a Tuesday. Everything is expressed as an absolute instant so the
// fixtures hold regardless of the machine's zone.
const NOON_UTC = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (dayOfMonth: number, hour: number, minute = 0) =>
  Date.UTC(2026, 8, dayOfMonth, hour, minute, 0);
const wrap = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join(
  '\r\n',
);
const vevent = (props: string[]) => wrap('BEGIN:VEVENT', ...props, 'END:VEVENT');

describe('unfoldLines', () => {
  it('rejoins a continuation folded mid-word', () => {
    expect(unfoldLines('SUMMARY:Weekly Stand\r\n up\r\nDESCRIPTION:x')).toEqual([
      'SUMMARY:Weekly Standup',
      'DESCRIPTION:x',
    ]);
  });

  it('accepts a tab as the continuation character and keeps inner whitespace', () => {
    expect(unfoldLines('A:one\r\n\ttwo   three\r\n ')).toEqual(['A:onetwo   three']);
  });

  it('drops a leading continuation line that has nothing to fold into', () => {
    expect(unfoldLines(' orphan\r\nA:1')).toEqual(['A:1']);
  });

  it('splits bare LF and CR documents', () => {
    expect(unfoldLines('A:1\nB:2')).toEqual(['A:1', 'B:2']);
    expect(unfoldLines('A:1\rB:2')).toEqual(['A:1', 'B:2']);
  });
});

describe('parseIcsDateTime', () => {
  it('reads a trailing Z as UTC', () => {
    expect(parseIcsDateTime('20260901T090000Z')).toBe(at(1, 9));
    expect(parseIcsDateTime('20260901T0900Z')).toBe(at(1, 9));
  });

  it('reads a wall-clock value without Z as local time', () => {
    expect(parseIcsDateTime('20260901T090000')).toBe(new Date(2026, 8, 1, 9, 0, 0).getTime());
  });

  it('treats a TZID value as local time rather than converting it', () => {
    expect(parseIcsDateTime('20260901T090000', 'Europe/Berlin')).toBe(
      new Date(2026, 8, 1, 9, 0, 0).getTime(),
    );
  });

  it('reads a date as local midnight', () => {
    expect(parseIcsDateTime('20260901')).toBe(new Date(2026, 8, 1, 0, 0, 0).getTime());
  });

  it('rejects junk', () => {
    expect(parseIcsDateTime('')).toBeNull();
    expect(parseIcsDateTime('2026-09-01T09:00:00Z')).toBeNull();
    expect(parseIcsDateTime('tomorrow')).toBeNull();
  });
});

describe('unescapeIcsText', () => {
  it('unescapes commas, semicolons, backslashes and \\N', () => {
    expect(unescapeIcsText('a\\,b\\;c\\\\d\\Ne')).toBe('a,b;c\\d\ne');
  });

  it('keeps an unknown escape verbatim', () => {
    expect(unescapeIcsText('keep \\q and trailing \\')).toBe('keep \\q and trailing \\');
  });
});

describe('filterEventWindow', () => {
  const events = [
    { title: 'later', startMs: at(1, 20), endMs: at(1, 21) },
    { title: 'now', startMs: at(1, 12), endMs: at(1, 13) },
    { title: 'overrun', startMs: at(1, 11), endMs: at(1, 12, 30) },
  ];

  it('keeps events that overlap the window, inclusive at both edges, sorted by start', () => {
    expect(filterEventWindow(events, at(1, 12), at(1, 13)).map((e) => e.title)).toEqual([
      'overrun',
      'now',
    ]);
  });

  it('drops events that ended before or start after the window', () => {
    expect(filterEventWindow(events, at(2, 8), at(2, 9))).toEqual([]);
  });
});

describe('parseIcs', () => {
  it('keeps the window, drops past and far-future events, and sorts by start', () => {
    const text = wrap(
      'BEGIN:VEVENT',
      'UID:far@x',
      'DTSTART:20260901T220000Z',
      'DTEND:20260901T223000Z',
      'SUMMARY:Far but inside 12h',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:past@x',
      'DTSTART:20260831T220000Z',
      'DTEND:20260831T223000Z',
      'SUMMARY:Yesterday',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:next-week@x',
      'DTSTART:20260907T090000Z',
      'DTEND:20260907T093000Z',
      'SUMMARY:Next week',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:near@x',
      'DTSTART:20260901T130000Z',
      'DTEND:20260901T133000Z',
      'SUMMARY:Soon',
      'END:VEVENT',
    );
    expect(parseIcs(text, new Date(NOON_UTC)).map((e) => e.title)).toEqual([
      'Soon',
      'Far but inside 12h',
    ]);
  });

  it('rejoins folded SUMMARY and DTSTART lines before parsing them', () => {
    const text = vevent([
      'UID:fold@x',
      'DTSTA',
      ' RT:202609',
      '01T140',
      '000Z',
      'SUMMARY:Quarterly ',
      ' Business Review',
      'DESCRIPTION:other long text that is folded too',
    ]);
    const events = parseIcs(text, new Date(NOON_UTC));
    expect(events).toEqual([
      { title: 'Quarterly Business Review', startMs: at(1, 14), endMs: at(1, 14) },
    ]);
  });

  it('parses TZID as local time and keeps the rest of the block intact', () => {
    const text = vevent([
      'UID:tz@x',
      'DTSTART;TZID=Europe/Berlin:20260901T150000',
      'DTEND;TZID=Europe/Berlin:20260901T153000',
      'SUMMARY:Local review',
    ]);
    expect(parseIcs(text, new Date(NOON_UTC))).toEqual([
      {
        title: 'Local review',
        startMs: new Date(2026, 8, 1, 15, 0, 0).getTime(),
        endMs: new Date(2026, 8, 1, 15, 30, 0).getTime(),
      },
    ]);
  });

  it('unescapes a comma, semicolon and backslash in SUMMARY', () => {
    const text = vevent([
      'UID:esc@x',
      'DTSTART:20260901T130000Z',
      'SUMMARY:Acme\\, Beta \\; gamma \\\\ delta',
    ]);
    expect(parseIcs(text, new Date(NOON_UTC))[0]!.title).toBe('Acme, Beta ; gamma \\ delta');
  });

  it('keeps an unterminated VEVENT at end of document and a missing DTEND as zero-length', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART:20260901T130000Z',
      'SUMMARY:No END line',
    ].join('\r\n');
    expect(parseIcs(text, new Date(NOON_UTC))).toEqual([
      { title: 'No END line', startMs: at(1, 13), endMs: at(1, 13) },
    ]);
  });

  it('skips events with an RRULE and keeps their non-recurring siblings', () => {
    const text = wrap(
      'BEGIN:VEVENT',
      'UID:weekly@x',
      'DTSTART:20260901T130000Z',
      'DTEND:20260901T133000Z',
      'SUMMARY:Weekly sync',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'END:VEVENT',
      vevent([
        'UID:one@x',
        'DTSTART:20260901T140000Z',
        'DTEND:20260901T143000Z',
        'SUMMARY:One-off',
      ]).split('\r\n').slice(1, -1).join('\r\n'),
    );
    expect(parseIcs(text, new Date(NOON_UTC)).map((e) => e.title)).toEqual(['One-off']);
  });

  it('skips all-day events in both DATE forms', () => {
    const text = wrap(
      'BEGIN:VEVENT',
      'UID:allday@x',
      'DTSTART;VALUE=DATE:20260901',
      'DTEND;VALUE=DATE:20260902',
      'SUMMARY:PTO',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:allday2@x',
      'DTSTART:20260901',
      'SUMMARY:Offsite',
      'END:VEVENT',
    );
    expect(parseIcs(text, new Date(NOON_UTC))).toEqual([]);
  });

  it('ignores VEVENTs without DTSTART and tolerates blank or junk lines', () => {
    const text = wrap(
      '',
      'X-WR-CALNAME:My Calendar',
      'BEGIN:VEVENT',
      'SUMMARY:No start at all',
      'END:VEVENT',
      ' ',
      'BEGIN:VEVENT',
      'UID:ok@x',
      'DTSTART:20260901T130000Z',
      'SUMMARY:Kept',
      'END:VEVENT',
    );
    expect(parseIcs(text, new Date(NOON_UTC)).map((e) => e.title)).toEqual(['Kept']);
  });

  it('takes the first SUMMARY when a block repeats properties', () => {
    const text = vevent([
      'UID:dup@x',
      'DTSTART:20260901T130000Z',
      'SUMMARY:First',
      'SUMMARY:Second',
      'DTEND:20260901T131500Z',
      'DTEND:20260901T140000Z',
    ]);
    const [event] = parseIcs(text, new Date(NOON_UTC));
    expect(event!.title).toBe('First');
    expect(event!.endMs).toBe(at(1, 13, 15));
  });

  it('inherits the DTSTART TZID when DTEND has none', () => {
    const text = vevent([
      'UID:inherit@x',
      'DTSTART;TZID=Europe/Berlin:20260901T150000',
      'DTEND:20260901T153000',
      'SUMMARY:Inherited zone',
    ]);
    const [event] = parseIcs(text, new Date(NOON_UTC));
    expect(event!.endMs - event!.startMs).toBe(30 * 60 * 1000);
  });

  it('caps the title length', () => {
    const text = vevent(['UID:long@x', 'DTSTART:20260901T130000Z', `SUMMARY:${'t'.repeat(400)}`]);
    expect(parseIcs(text, new Date(NOON_UTC))[0]!.title).toHaveLength(200);
  });

  it('is case-insensitive for property names, block markers and the UTC designator', () => {
    const text = wrap(
      'BEGIN:vevent',
      'Uid:case@x',
      'dtstart:20260901T130000z',
      'summary:Lower case',
      'END:vevent',
    );
    expect(parseIcs(text, new Date(NOON_UTC))).toEqual([
      { title: 'Lower case', startMs: at(1, 13), endMs: at(1, 13) },
    ]);
  });

  it('survives an empty or garbage document', () => {
    expect(parseIcs('', new Date(NOON_UTC))).toEqual([]);
    expect(parseIcs('not a calendar at all\r\n\x00\x01', new Date(NOON_UTC))).toEqual([]);
  });
});

describe('matchUpcomingEvent', () => {
  const events = [
    { title: 'soon', startMs: at(1, 13), endMs: at(1, 13, 30) },
    { title: 'live-short', startMs: at(1, 12), endMs: at(1, 12, 1) },
    { title: 'live-long', startMs: at(1, 11, 30), endMs: at(1, 12, 30) },
  ];

  it('returns null when nothing overlaps', () => {
    expect(matchUpcomingEvent(events, NOON_UTC, 0)?.title).toBe('live-long');
    expect(matchUpcomingEvent([], NOON_UTC, 5 * 60 * 1000)).toBeNull();
  });

  it('applies the ± skew on both edges', () => {
    const five = 5 * 60 * 1000;
    expect(matchUpcomingEvent(events, at(1, 13, 40), five)).toBeNull();
    expect(matchUpcomingEvent(events, at(1, 13, 34), five)?.title).toBe('soon');
    expect(matchUpcomingEvent(events, at(1, 12, 20), five)?.title).toBe('live-long');
    expect(matchUpcomingEvent(events, at(1, 11, 25), five)?.title).toBe('live-long');
  });

  it('prefers the earliest start, then the longest overlap', () => {
    expect(matchUpcomingEvent(events, NOON_UTC, 5 * 60 * 1000)?.title).toBe('live-long');
  });
});

describe('fetchUpcomingEvents', () => {
  const valid = vevent([
    'UID:net@x',
    'DTSTART:20260901T130000Z',
    'DTEND:20260901T133000Z',
    'SUMMARY:Design sync',
  ]);

  function mockFetch(body: string, init: { ok?: boolean; status?: number } = {}) {
    const calls: { url: string; signal?: AbortSignal }[] = [];
    const impl = async (url: string | URL | Request, opts?: RequestInit) => {
      calls.push({ url: String(url), signal: opts?.signal ?? undefined });
      return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        headers: { get: () => null },
        text: async () => body,
      };
    };
    return {
      calls,
      fetchImpl: impl as unknown as typeof fetch,
    };
  }

  beforeEach(() => clearIcsCache());
  afterEach(() => clearIcsCache());

  it('returns nothing and never calls fetch when no URL is configured', async () => {
    const { calls, fetchImpl } = mockFetch(valid);
    expect(await fetchUpcomingEvents({ fetchImpl, now: new Date(NOON_UTC) })).toEqual([]);
    expect(await fetchUpcomingEvents({ icsUrl: '   ', fetchImpl, now: new Date(NOON_UTC) })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refuses calendar URLs that are not HTTPS', async () => {
    const { calls, fetchImpl } = mockFetch(valid);
    expect(
      await fetchUpcomingEvents({
        icsUrl: 'http://cal.example.com/private/basic.ics',
        fetchImpl,
        now: new Date(NOON_UTC),
      }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fetches the configured URL and parses the feed', async () => {
    const { calls, fetchImpl } = mockFetch(valid);
    const events = await fetchUpcomingEvents({
      icsUrl: 'https://cal.example.com/private/basic.ics',
      fetchImpl,
      now: new Date(NOON_UTC),
    });
    expect(events).toEqual([{ title: 'Design sync', startMs: at(1, 13), endMs: at(1, 13, 30) }]);
    expect(calls[0]!.url).toBe('https://cal.example.com/private/basic.ics');
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves a second call from the cache without refetching', async () => {
    const { calls, fetchImpl } = mockFetch(valid);
    const args = { icsUrl: 'https://cal.example.com/a.ics', fetchImpl };
    expect(await fetchUpcomingEvents({ ...args, now: new Date(NOON_UTC) })).toHaveLength(1);
    expect(await fetchUpcomingEvents({ ...args, now: new Date(NOON_UTC + 60_000) })).toHaveLength(1);
    expect(calls).toHaveLength(1);

    // Past the TTL the feed is fetched again.
    await fetchUpcomingEvents({ ...args, now: new Date(NOON_UTC + ICS_CACHE_TTL_MS + 1000) });
    expect(calls).toHaveLength(2);
  });

  it('caches per URL', async () => {
    const a = mockFetch(valid);
    const b = mockFetch(vevent(['UID:other@x', 'DTSTART:20260901T140000Z', 'SUMMARY:Other feed']));
    await fetchUpcomingEvents({ icsUrl: 'https://cal.example.com/a.ics', fetchImpl: a.fetchImpl, now: new Date(NOON_UTC) });
    const events = await fetchUpcomingEvents({
      icsUrl: 'https://cal.example.com/b.ics',
      fetchImpl: b.fetchImpl,
      now: new Date(NOON_UTC),
    });
    expect(events.map((e) => e.title)).toEqual(['Other feed']);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('returns nothing on an HTTP error, a thrown fetch, or an unparsable body', async () => {
    const icsUrl = 'https://cal.example.com/a.ics';
    const now = new Date(NOON_UTC);

    const http = mockFetch(valid, { ok: false, status: 500 });
    expect(await fetchUpcomingEvents({ icsUrl, now, fetchImpl: http.fetchImpl })).toEqual([]);

    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await fetchUpcomingEvents({ icsUrl, now, fetchImpl: boom })).toEqual([]);

    const junk = mockFetch('this is not an ics file');
    expect(await fetchUpcomingEvents({ icsUrl, now, fetchImpl: junk.fetchImpl })).toEqual([]);
  });
});

describe('readBodyCapped', () => {
  it('returns the whole body when it fits', async () => {
    const response = {
      headers: { get: () => null },
      text: async () => 'inline text',
    } as unknown as Response;
    expect(await readBodyCapped(response, 'https://x/y.ics', 1024)).toBe('inline text');
  });

  it('cancels a body whose declared length exceeds the cap', async () => {
    let cancelled = false;
    const response = {
      headers: { get: (name: string) => (name === 'content-length' ? '1025' : null) },
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
      text: async () => {
        throw new Error('must not be read');
      },
    } as unknown as Response;
    expect(await readBodyCapped(response, 'https://x/y.ics', 1024)).toBe('');
    expect(cancelled).toBe(true);
  });

  it('cancels a streaming body that exceeds the cap', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(600);
    const response = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: chunk }),
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    } as unknown as Response;
    expect(await readBodyCapped(response, 'https://x/y.ics', 1024)).toBe('');
    expect(cancelled).toBe(true);
  });

  it('decodes a streaming body that fits', async () => {
    const parts = [new TextEncoder().encode('BEGIN:VAL'), new TextEncoder().encode('END:CAL')];
    let index = 0;
    const response = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            index < parts.length ? { done: false, value: parts[index++] } : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
    expect(await readBodyCapped(response, 'https://x/y.ics', 1024)).toBe('BEGIN:VALEND:CAL');
  });
});
