// Minimal RFC 5545 iCalendar parser: unfolds CRLF lines **folded** by RFC 5545 section 3.1:
// (a continuation line starts with a single space or tab), keeps VEVENT blocks, and filters
// to an upcoming window. Deliberately small: no VTIMEZONE database, no METHOD/PUBLISH
// handling, no property-parameter grammar beyond what the common calendar providers emit.
//
// Documented limitations:
//   - RRULE: any recurring event is SKIPPED. Expanding recurrences correctly needs
//     UNTIL/COUNT/INTERVAL semantics we do not implement, and guessing wrong would put a
//     wrong title on a user's meeting record.
//   - DTSTART with a TZID is parsed as *local* wall time (no zone conversion).
//   - All-day events (VALUE=DATE) are skipped.
//   - A folded line whose continuation is blank ("..." + CRLF + " " + CRLF) drops the line
//     break, which is a lossy but acceptable reading of the spec for SUMMARY-only use.
//   - Some feeds split a long line at 75 octets but forget the fold character. Those
//     fragments are re-joined for DTSTART/DTEND only (see `joinSplitDateTimeLines`); for
//     any other property a guess could corrupt a value we cannot validate, so the
//     fragment is dropped instead.

export interface IcsEvent {
  title: string;
  startMs: number;
  endMs: number;
}

export const UPCOMING_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 h
export const ICS_FETCH_TIMEOUT_MS = 5_000;
export const ICS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ICS_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_CHARS = 200;

/**
 * RFC 5545 line unfolding (section 3.1): a CRLF followed by a single space or
 * tab continues the previous line. The continuation character is removed, the
 * rest is appended verbatim, so a split token rejoins exactly.
 */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (raw[0] === ' ' || raw[0] === '\t') {
      if (out.length === 0) continue; // leading whitespace before any content
      const previous = out.pop()!;
      out.push(previous + raw.slice(1));
      continue;
    }
    out.push(raw);
  }
  return out;
}

/** Split `NAME;PARAM=VAL;PARAM2:value` into its name, params and raw value. */
function splitProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const name = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = name.split(';');
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: parts[0]!.toUpperCase(), params, value };
}

/** Unescape TEXT param values: \\N / \\n → newline, then \\, and \\. */
export function unescapeIcsText(value: string): string {
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch !== '\\' || i === value.length - 1) {
      out.push(ch);
      continue;
    }
    const next = value[i + 1]!;
    if (next === 'N' || next === 'n') {
      out.push('\n');
      i++;
      continue;
    }
    if (next === ',' || next === ';' || next === '\\') {
      out.push(next);
      i++;
      continue;
    }
    out.push(ch); // unknown escape: keep the backslash and the character as-is
  }
  return out.join('');
}

const DATE_TIME_PROPS = new Set(['DTSTART', 'DTEND']);

/**
 * Second pass over the unfolded lines: re-join a colon-less fragment onto a preceding
 * `DTSTART`/`DTEND` line *only while that line's value still fails to parse*, which is
 * what a truncated date-time looks like (`DTSTART:202609` / `01T140` / `000Z`). Any other
 * colon-less line is left alone and is then ignored as a non-property line.
 */
export function joinSplitDateTimeLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.includes(':') && out.length > 0) {
      const prev = out[out.length - 1]!;
      const prop = splitProperty(prev);
      if (
        prop &&
        DATE_TIME_PROPS.has(prop.name) &&
        parseIcsDateTime(prop.value, prop.params.TZID) === null
      ) {
        out[out.length - 1] = prev + line;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * `YYYYMMDD`, `YYYYMMDDThhmm[ss]`, optionally suffixed with `Z`.
 * A trailing `Z` is UTC; anything else (bare, or carrying a TZID) is read as *local*
 * wall time by `new Date(y, mo, d, ...)` — documented above.
 */
const ICS_DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/i;

export function parseIcsDateTime(value: string, _tzid?: string): number | null {
  const m = ICS_DATE_TIME.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', zulu] = m;
  const [yy, mm, dd, hh, mmin, ss] = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];
  if (![yy, mm, dd, hh, mmin, ss].every((n) => Number.isFinite(n))) return null;
  // _tzid is intentionally ignored: a TZID value is read as local wall time.
  if (zulu) return Date.UTC(yy!, mm!, dd!, hh!, mmin!, ss!);
  return new Date(yy!, mm!, dd!, hh!, mmin!, ss!).getTime();
}

/** True for all-day values (`YYYYMMDD`, or an explicit VALUE=DATE). */
function isAllDay(value: string, params: Record<string, string>): boolean {
  if (params.VALUE?.toUpperCase() === 'DATE') return true;
  return /^\d{8}$/.test(value.trim());
}

function endOrStart(startMs: number, endValue: string, tzid: string | undefined): number {
  return parseIcsDateTime(endValue, tzid) ?? startMs;
}

/** Events overlapping `[windowStartMs, windowEndMs]`, sorted by start. */
export function filterEventWindow(events: IcsEvent[], windowStartMs: number, windowEndMs: number): IcsEvent[] {
  return events
    .filter((e) => e.startMs <= windowEndMs && e.endMs >= windowStartMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** Parse an .ics document into the events that overlap `now .. now + 12h`. */
export function parseIcs(text: string, now: Date): IcsEvent[] {
  const lines = joinSplitDateTimeLines(unfoldLines(text));
  const events: IcsEvent[] = [];

  let inEvent = false;
  let summary: string | null = null;
  let start: { value: string; tzid: string | undefined; allDay: boolean } | null = null;
  let end: { value: string; tzid: string | undefined } | null = null;
  let recurring = false;

  const reset = (): void => {
    inEvent = false;
    summary = null;
    start = null;
    end = null;
    recurring = false;
  };

  const finishEvent = (): void => {
    if (!inEvent || recurring || !start || start.allDay) {
      reset();
      return;
    }
    const startMs = parseIcsDateTime(start.value, start.tzid);
    if (startMs !== null) {
      events.push({
        title: (summary ? unescapeIcsText(summary) : '').trim().slice(0, MAX_TITLE_CHARS),
        startMs,
        endMs: end ? endOrStart(startMs, end.value, end.tzid) : startMs,
      });
    }
    reset();
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = splitProperty(line);
    if (!prop) continue;
    const { name, params, value } = prop;

    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') {
      reset();
      inEvent = true;
      continue;
    }
    if (!inEvent) continue;
    if (name === 'END' && value.toUpperCase() === 'VEVENT') {
      finishEvent(); // real feeds terminate the block
      continue;
    }

    switch (name) {
      case 'SUMMARY':
        if (summary === null) summary = value;
        break;
      case 'DTSTART':
        if (!start) {
          start = { value, tzid: params.TZID, allDay: isAllDay(value, params) };
        }
        break;
      case 'DTEND':
        if (!end) end = { value, tzid: params.TZID ?? start?.tzid };
        break;
      case 'RRULE':
        recurring = true; // documented limitation: recurring events are skipped
        break;
      default:
        break;
    }
  }

  finishEvent(); // a truncated document can end mid-VEVENT; keep the partial event

  const nowMs = now.getTime();
  return filterEventWindow(events, nowMs, nowMs + UPCOMING_WINDOW_MS);
}

/** The most specific event overlapping `now ±skewMs`, or null. */
export function matchUpcomingEvent(
  events: { title: string; startMs: number; endMs: number }[],
  nowMs: number,
  skewMs: number,
): { title: string; startMs: number; endMs: number } | null {
  const matches = events
    .filter((e) => e.startMs <= nowMs + skewMs && e.endMs >= nowMs - skewMs)
    .sort((a, b) => a.startMs - b.startMs || b.endMs - b.startMs - (a.endMs - a.startMs));
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fetching (host-side only; `icsUrl` is user-configured and unset by default)
// ---------------------------------------------------------------------------

export interface UpcomingEventsDeps {
  icsUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

interface IcsCacheEntry {
  /** Milliseconds, not a Date: Date.now() is fine here (host process, no resume clock). */
  fetchedAt: number;
  events: IcsEvent[];
}

const cache = new Map<string, IcsCacheEntry>();

/** Feed URLs carry a private token in the path, so logs only ever show the origin. */
function urlLabel(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'configured calendar';
  }
}

/** Only HTTPS calendars — a configured URL must never reach the local filesystem. */
export function isHttpsCalendarUrl(url: string): boolean {
  try {
    const proto = new URL(url).protocol.toLowerCase();
    return proto === 'https:';
  } catch {
    return false;
  }
}

/** Visible for tests. */
export function clearIcsCache(): void {
  cache.clear();
}

export async function fetchUpcomingEvents(deps: UpcomingEventsDeps): Promise<IcsEvent[]> {
  const url = deps.icsUrl?.trim();
  if (!url) return [];
  if (!isHttpsCalendarUrl(url)) {
    process.stderr.write(
      `[scribetab-host] ignoring calendar URL that is not HTTPS: ${urlLabel(url)}\n`,
    );
    return [];
  }

  const now = deps.now ?? new Date();
  const timeoutMs = deps.timeoutMs ?? ICS_FETCH_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? ICS_CACHE_TTL_MS;
  const nowMs = now.getTime();

  const hit = cache.get(url);
  // Re-filter the cached set against the requested `now` instead of refetching. The
  // window can only shrink as the clock advances (entries were parsed for the fetch-time
  // window), which is fine within a 5-minute TTL and keeps the cache testable.
  if (hit && nowMs - hit.fetchedAt < cacheTtlMs) {
    return hit.events.filter((e) => e.startMs <= nowMs + UPCOMING_WINDOW_MS && e.endMs >= nowMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      const fetchImpl = deps.fetchImpl ?? fetch;
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'text/calendar, text/plain, */*' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Calendar returned HTTP ${response.status}`);
    const text = await readBodyCapped(response, url, MAX_ICS_BYTES);
    const events = parseIcs(text, now);
    cache.set(url, { fetchedAt: nowMs, events });
    return events;
  } catch (e) {
    // Never let a calendar failure surface as a host error: log a line, return empty.
    process.stderr.write(
      `[scribetab-host] calendar fetch failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return [];
  }
}
/**
 * Read at most `cap` bytes — a calendar URL that streams an unbounded body must not be
 * able to balloon host memory. Returns the full text when the body stays under the cap,
 * otherwise the empty string (the feed is too big to be a calendar we should parse) and
 * consumes the stream so the connection closes.
 */
export async function readBodyCapped(response: Response, url: string, cap = MAX_ICS_BYTES): Promise<string> {
  const declared = Number(response.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => {});
    return '';
  }
  const reader = response.body?.getReader?.();
  if (!reader) return response.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      process.stderr.write(
        `[scribetab-host] calendar feed at ${urlLabel(url)} exceeds ${cap} bytes, ignoring\n`,
      );
      return '';
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
