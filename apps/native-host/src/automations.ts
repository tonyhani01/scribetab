/**
 * Host automations: rule-based routing of post-sync integrations.
 *
 * Pure string/logic module — no filesystem access and no config reads.
 * `config.ts` uses `parseAutomations` to validate stored rules, and
 * `integrations.ts` uses `obsidianSubfolderFor` / `matchAutomations` to route
 * the markdown copy that the enabled integrations already produce.
 *
 * Semantics (deliberately narrow, see docs/superpowers/plans plan D4):
 * - Rules only ROUTE what an enabled integration already does. They never
 *   enable a disabled integration, and a non-matching rule never suppresses
 *   an integration: with no rules (or no matches) behaviour is unchanged.
 * - An Obsidian rule may name a vault-relative `subfolder`; the copy then
 *   lands in `<vault>/ScribeTab/<subfolder>/` instead of `<vault>/ScribeTab/`.
 *   Rules are ordered: the first matching Obsidian rule that carries a
 *   `subfolder` decides the destination, and only one copy is written.
 * - A Notion rule is parsed and matched but currently has no routing effect —
 *   Notion always writes under the configured `notion.parentPageId`.
 */

import { isAbsolute, join } from 'node:path';

export type AutomationDestination = 'obsidian' | 'notion';

export interface AutomationRule {
  /** Case-insensitive substring of the session title; absent matches every title. */
  titleContains?: string;
  destination: AutomationDestination;
  /** Sanitized, vault-relative, POSIX-separated folder for the Obsidian copy. */
  subfolder?: string;
}

export const AUTOMATION_MAX_RULES = 50;
export const SUBFOLDER_MAX_CHARS = 128;
export const SUBFOLDER_MAX_SEGMENTS = 8;

/** Characters that break Obsidian/Windows paths, plus control chars. */
const BAD_SEGMENT_RE = /[<>:"|?*\\[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function fail(message: string): never {
  throw new Error(`Host config automations ${message}`);
}

/**
 * Normalize a user-supplied vault-relative subfolder into a POSIX-separated
 * relative path. Backslashes (Windows) are accepted as separators.
 *
 * @throws if the value is empty, absolute, escapes the vault via `..`,
 * contains characters that are unsafe in a path, or exceeds the size limits.
 */
export function sanitizeSubfolder(raw: string): string {
  const unified = raw.trim().replace(/\\/g, '/');
  if (!unified) fail('subfolder must not be empty');
  if (unified.startsWith('/')) fail(`subfolder must be relative, got ${JSON.stringify(raw)}`);
  if (/^[a-zA-Z]:/.test(unified)) fail(`subfolder must not contain a drive letter, got ${JSON.stringify(raw)}`);
  const segments = unified.split('/').map((s) => s.trim());
  if (segments.length > SUBFOLDER_MAX_SEGMENTS) fail(`subfolder must have at most ${SUBFOLDER_MAX_SEGMENTS} segments`);
  for (const seg of segments) {
    if (!seg) fail('subfolder must not contain empty path segments');
    if (seg === '.') fail(`subfolder must not contain "." segments`);
    if (seg === '..') fail(`subfolder must not contain ".." (cannot escape the vault)`);
    if (seg.startsWith('.')) fail(`subfolder segment ${JSON.stringify(seg)} must not start with "."`);
    if (seg.endsWith('.')) fail(`subfolder segment ${JSON.stringify(seg)} must not end with "."`);
    if (BAD_SEGMENT_RE.test(seg)) fail(`subfolder segment ${JSON.stringify(seg)} contains unsafe characters`);
    if (WINDOWS_RESERVED_RE.test(seg)) fail(`subfolder segment ${JSON.stringify(seg)} is reserved on Windows`);
  }
  const out = segments.join('/');
  if (out.length > SUBFOLDER_MAX_CHARS) fail(`subfolder must be at most ${SUBFOLDER_MAX_CHARS} characters`);
  return out;
}

/** Validate an optional `subfolder` value: `undefined` when absent or blank. */
export function sanitizeOptionalSubfolder(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') fail('subfolder must be a string');
  const trimmed = raw.trim();
  return trimmed ? sanitizeSubfolder(trimmed) : undefined;
}

/**
 * Split a sanitized subfolder into its path segments, re-validating each one
 * so a hand-built rule can never walk out of the vault.
 */
export function subfolderSegments(subfolder: string): string[] {
  const segments = subfolder.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.startsWith('.') || isAbsolute(seg) || BAD_SEGMENT_RE.test(seg)) {
      fail(`segment ${JSON.stringify(seg)} is not safe to join under the vault`);
    }
  }
  return segments;
}

/** Join an already-sanitized subfolder under `base`, defensively re-validating. */
export function joinSanitizedSubfolder(base: string, subfolder: string): string {
  let dir = base;
  for (const seg of subfolderSegments(subfolder)) dir = join(dir, seg);
  return dir;
}

/** Validate a raw `automations` value from config JSON into ordered rules. */
export function parseAutomations(raw: unknown): AutomationRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('must be an array');
  if (raw.length > AUTOMATION_MAX_RULES) fail(`must have at most ${AUTOMATION_MAX_RULES} rules`);
  return raw.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) fail(`rule ${i} must be an object`);
    const o = item as Record<string, unknown>;
    if (o.destination !== 'obsidian' && o.destination !== 'notion') {
      fail(`rule ${i} destination must be "obsidian" or "notion"`);
    }
    const rule: AutomationRule = { destination: o.destination };
    if (o.titleContains !== undefined && o.titleContains !== null) {
      if (typeof o.titleContains !== 'string') fail(`rule ${i} titleContains must be a string`);
      const needle = o.titleContains.trim();
      if (needle) rule.titleContains = needle;
    }
    const subfolder = sanitizeOptionalSubfolder(o.subfolder);
    if (subfolder) rule.subfolder = subfolder;
    return rule;
  });
}

function ruleMatches(rule: AutomationRule, haystack: string): boolean {
  if (typeof rule !== 'object' || rule === null) return false;
  if (rule.destination !== 'obsidian' && rule.destination !== 'notion') return false;
  const needle = typeof rule.titleContains === 'string' ? rule.titleContains.trim().toLowerCase() : '';
  if (!needle) return true; // unconditional rule
  return haystack.includes(needle);
}

/** Rules whose title condition holds for `title` (case-insensitive substring). */
export function matchAutomations(rules: AutomationRule[], title: string): AutomationRule[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const haystack = (typeof title === 'string' ? title : '').toLowerCase();
  return rules.filter((rule) => ruleMatches(rule, haystack));
}

/** Where the Obsidian copy goes for this title: `undefined` keeps the default folder. */
export function obsidianSubfolderFor(rules: AutomationRule[], title: string): string | undefined {
  for (const rule of matchAutomations(rules, title)) {
    if (rule.destination === 'obsidian' && rule.subfolder) return rule.subfolder;
  }
  return undefined;
}
