import { describe, expect, it } from 'vitest';
import {
  joinSanitizedSubfolder,
  matchAutomations,
  obsidianSubfolderFor,
  parseAutomations,
  sanitizeOptionalSubfolder,
  sanitizeSubfolder,
  subfolderSegments,
  type AutomationRule,
} from '../src/automations.js';

describe('matchAutomations', () => {
  const rules: AutomationRule[] = [
    { titleContains: 'Acme', destination: 'obsidian', subfolder: 'Clients/Acme' },
    { titleContains: 'standup', destination: 'obsidian' },
    { titleContains: 'Interview', destination: 'notion' },
  ];

  it('matches case-insensitive substrings of the title', () => {
    expect(matchAutomations(rules, 'ACME Q1 Review').map((r) => r.titleContains)).toEqual(['Acme']);
    expect(matchAutomations(rules, 'Daily Standup').map((r) => r.destination)).toEqual(['obsidian']);
    expect(matchAutomations(rules, 'Data Interview — backend').map((r) => r.titleContains)).toEqual(['Interview']);
  });

  it('returns every matching rule, in config order', () => {
    const out = matchAutomations(rules, 'Acme interview');
    expect(out.map((r) => r.titleContains)).toEqual(['Acme', 'Interview']);
  });

  it('treats a rule without titleContains as unconditional', () => {
    const all: AutomationRule[] = [{ destination: 'obsidian', subfolder: 'Inbox' }, ...rules];
    expect(matchAutomations(all, 'Nothing matches this')).toEqual([all[0]]);
  });

  it('returns nothing for an empty rule set, empty title or non-matching title', () => {
    expect(matchAutomations([], 'Anything')).toEqual([]);
    expect(matchAutomations(rules, '')).toEqual([]);
    expect(matchAutomations(rules, 'Unrelated call')).toEqual([]);
  });

  it('tolerates garbage rules instead of throwing at sync time', () => {
    const junk = [null, {}, { destination: 'obsidian' }] as unknown as AutomationRule[];
    expect(matchAutomations(junk, 'Whatever')).toEqual([{ destination: 'obsidian' }]);
  });
});

describe('sanitizeSubfolder', () => {
  it('normalizes separators and redundant whitespace', () => {
    expect(sanitizeSubfolder('Clients/Acme')).toBe('Clients/Acme');
    expect(sanitizeSubfolder('  Clients\\Acme\\Q1  ')).toBe('Clients/Acme/Q1');
    expect(sanitizeSubfolder('Clients / Acme')).toBe('Clients/Acme');
    expect(sanitizeSubfolder('Notes')).toBe('Notes');
  });

  it('rejects paths that escape or bypass the vault', () => {
    expect(() => sanitizeSubfolder('..')).toThrow(/automations/);
    expect(() => sanitizeSubfolder('../evil')).toThrow(/\.\./);
    expect(() => sanitizeSubfolder('Clients/../../evil')).toThrow(/\.\./);
    expect(() => sanitizeSubfolder('Clients/./Acme')).toThrow(/"\." segments/);
    expect(() => sanitizeSubfolder('/etc')).toThrow(/relative/);
    expect(() => sanitizeSubfolder('\\\\server\\share')).toThrow(/drive letter|relative/);
    expect(() => sanitizeSubfolder('C:/Windows')).toThrow(/drive letter/);
  });

  it('rejects empty, unsafe, oversized and reserved segments', () => {
    expect(() => sanitizeSubfolder('Clients//Acme')).toThrow(/empty path segments/);
    expect(() => sanitizeSubfolder('Clients/Acme:NY')).toThrow(/unsafe characters/);
    expect(() => sanitizeSubfolder('Clients/.hidden')).toThrow(/must not start with/);
    expect(() => sanitizeSubfolder('Clients/Acme.')).toThrow(/must not end with/);
    expect(() => sanitizeSubfolder(`Clients/Ac\u0000me`)).toThrow(/unsafe characters/);
    expect(() => sanitizeSubfolder('Clients/NUL')).toThrow(/reserved on Windows/);
    expect(() => sanitizeSubfolder('a/b/c/d/e/f/g/h/i')).toThrow(/at most 8 segments/);
    expect(() => sanitizeSubfolder('x'.repeat(129))).toThrow(/at most 128 characters/);
  });

  it('rejects blank values instead of silently meaning the vault root', () => {
    expect(() => sanitizeSubfolder('   ')).toThrow(/must not be empty/);
    expect(sanitizeOptionalSubfolder(undefined)).toBeUndefined();
    expect(sanitizeOptionalSubfolder('')).toBeUndefined();
    expect(sanitizeOptionalSubfolder('Clients/Acme')).toBe('Clients/Acme');
    expect(() => sanitizeOptionalSubfolder(42)).toThrow(/must be a string/);
  });
});

describe('subfolderSegments / joinSanitizedSubfolder', () => {
  it('composes paths from validated segments only', () => {
    expect(subfolderSegments('Clients/Acme')).toEqual(['Clients', 'Acme']);
    expect(joinSanitizedSubfolder('/vault/ScribeTab', 'Clients/Acme')).toBe('/vault/ScribeTab/Clients/Acme');
    expect(() => joinSanitizedSubfolder('/vault/ScribeTab', '../escape')).toThrow(/not safe to join/);
    expect(() => joinSanitizedSubfolder('/vault/ScribeTab', '/abs')).toThrow(/not safe to join/);
    expect(() => joinSanitizedSubfolder('/vault/ScribeTab', 'ok/..')).toThrow(/not safe to join/);
  });
});

describe('parseAutomations', () => {
  it('accepts a well-formed rule list and trims fields', () => {
    expect(
      parseAutomations([
        { titleContains: '  Acme  ', destination: 'obsidian', subfolder: 'Clients/Acme' },
        { destination: 'notion' },
      ]),
    ).toEqual([
      { titleContains: 'Acme', destination: 'obsidian', subfolder: 'Clients/Acme' },
      { destination: 'notion' },
    ]);
    expect(parseAutomations(undefined)).toEqual([]);
    expect(parseAutomations([])).toEqual([]);
  });

  it('drops blank optional fields rather than storing empty strings', () => {
    expect(parseAutomations([{ destination: 'obsidian', titleContains: '  ', subfolder: '' }])).toEqual([
      { destination: 'obsidian' },
    ]);
  });

  it('rejects malformed rules', () => {
    expect(() => parseAutomations('x')).toThrow(/must be an array/);
    expect(() => parseAutomations(['x'])).toThrow(/rule 0 must be an object/);
    expect(() => parseAutomations([{ destination: 'slack' }])).toThrow(/destination/);
    expect(() => parseAutomations([{ destination: 'obsidian', titleContains: 7 }])).toThrow(/titleContains/);
    expect(() => parseAutomations([{ destination: 'obsidian', subfolder: '../out' }])).toThrow(/\.\./);
    expect(() => parseAutomations(Array.from({ length: 51 }, () => ({ destination: 'obsidian' })))).toThrow(
      /at most 50 rules/,
    );
  });
});

describe('obsidianSubfolderFor', () => {
  const rules: AutomationRule[] = [
    { titleContains: 'Interview', destination: 'notion' },
    { titleContains: 'Client', destination: 'obsidian' },
    { titleContains: 'Acme', destination: 'obsidian', subfolder: 'Clients/Acme' },
    { titleContains: 'Sprint', destination: 'obsidian', subfolder: 'Engineering/Sprints' },
  ];

  it('returns the subfolder of the first matching Obsidian rule that has one', () => {
    expect(obsidianSubfolderFor(rules, 'Acme client call')).toBe('Clients/Acme');
    expect(obsidianSubfolderFor(rules, 'Sprint planning')).toBe('Engineering/Sprints');
  });

  it('ignores rules without a subfolder and Notion rules', () => {
    expect(obsidianSubfolderFor(rules, 'Client check-in')).toBeUndefined();
    expect(obsidianSubfolderFor([{ destination: 'notion', subfolder: 'Nope' }], 'Anything')).toBeUndefined();
  });

  it('defaults to the vault folder when there are no rules', () => {
    expect(obsidianSubfolderFor([], 'Acme standup')).toBeUndefined();
  });
});
