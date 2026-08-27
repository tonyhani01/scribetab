import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG_MAX } from './constants.js';

/** Filesystem-safe slug: `[a-z0-9-]`, max 60 chars. */
export function slugify(title: string, max = SLUG_MAX): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'meeting';
}

export function datePrefix(startedAt: string): string {
  const d = startedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
}

export function meetingDirBase(startedAt: string, title: string): string {
  return `${datePrefix(startedAt)}-${slugify(title)}`;
}

/**
 * First unused directory: `base`, then `base-2`, `base-3`, ...
 * `exists` is injectable for tests.
 */
export function uniqueMeetingDir(
  meetingsRoot: string,
  base: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const first = join(meetingsRoot, base);
  if (!exists(first)) return first;
  for (let n = 2; n < 10_000; n++) {
    const p = join(meetingsRoot, `${base}-${n}`);
    if (!exists(p)) return p;
  }
  throw new Error(`Too many slug collisions for ${base}`);
}
