import { describe, expect, it } from 'vitest';
import { meetingDirBase, slugify, uniqueMeetingDir } from '../src/slug.js';

describe('slugify', () => {
  it('lowercases and keeps [a-z0-9-]', () => {
    expect(slugify('Weekly Standup')).toBe('weekly-standup');
  });

  it('strips punctuation and collapses dashes', () => {
    expect(slugify('Hello, World!!! Foo_Bar')).toBe('hello-world-foo-bar');
  });

  it('strips accents', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume');
  });

  it('falls back to meeting when empty', () => {
    expect(slugify('???')).toBe('meeting');
    expect(slugify('')).toBe('meeting');
  });

  it('caps at 60 chars without a trailing dash', () => {
    const s = slugify('a'.repeat(80));
    expect(s.length).toBe(60);
    expect(s).not.toMatch(/-$/);
    const dashed = slugify(`${'n'.repeat(58)}!!!more`);
    expect(dashed.length).toBeLessThanOrEqual(60);
    expect(dashed).not.toMatch(/-$/);
  });
});

describe('meetingDirBase', () => {
  it('prefixes YYYY-MM-DD from startedAt', () => {
    expect(meetingDirBase('2026-08-27T15:04:00.000Z', 'Weekly Standup')).toBe(
      '2026-08-27-weekly-standup',
    );
  });
});

describe('uniqueMeetingDir', () => {
  it('returns base when free, then -2, -3 on collision', () => {
    const taken = new Set<string>();
    const exists = (p: string) => taken.has(p);
    const first = uniqueMeetingDir('/m', '2026-08-27-weekly-standup', exists);
    expect(first).toBe('/m/2026-08-27-weekly-standup');
    taken.add(first);
    expect(uniqueMeetingDir('/m', '2026-08-27-weekly-standup', exists)).toBe(
      '/m/2026-08-27-weekly-standup-2',
    );
    taken.add('/m/2026-08-27-weekly-standup-2');
    expect(uniqueMeetingDir('/m', '2026-08-27-weekly-standup', exists)).toBe(
      '/m/2026-08-27-weekly-standup-3',
    );
  });
});
