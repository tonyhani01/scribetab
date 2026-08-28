# Structured Summary + Action-Item Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Structured LLM session summaries (narrative / action items / decisions / useful info), a user-editable guidance prompt, and checkbox-selected export of action items to Notion `to_do` blocks via the native host.

**Architecture:** Pure logic (schema, prompt assembly, JSON parsing, markdown derivation) lives in `packages/shared`. The extension background stores a `SessionSummary` per session and derives the legacy `summaryMarkdown` from it. Export is a new native-messaging message handled by the host, which reuses the existing hardened Notion client and adds a `notionActions.json` idempotency map.

**Tech Stack:** TypeScript, Preact (side panel/options), WXT, vitest, Chrome native messaging, Notion REST API.

**Spec:** `docs/superpowers/specs/2026-08-27-structured-summary-and-action-export-design.md`

## Global Constraints

- Monorepo commands run from repo root with pnpm: `pnpm --filter @scribetab/shared test`, `pnpm --filter scribetab-native-host test`, `pnpm --filter scribetab-extension test` (check exact package names in each `package.json` before running; extension package name is in `apps/extension/package.json`).
- Native-host tests require a fresh shared build: `pnpm --filter @scribetab/shared build` runs automatically via `pretest`.
- TDD: every behavior lands test-first. Extension UI (`.tsx`) is verified by `pnpm --filter scribetab-extension typecheck` + build only — no component test harness.
- Never touch `git stash`. Never push to remotes.
- Existing behavior that must not change: transcript clipping (`SUMMARY_TRANSCRIPT_CHAR_LIMIT = 24_000`), `DATA_FRAMING` injection warning, redaction before LLM calls, `intelligence: 'pending' | 'needs-permission' | null` state machine, Notion constants (`NOTION_RICH_TEXT_MAX = 2000`, `NOTION_CHILDREN_MAX = 100`, `NOTION_BATCH_MAX_BYTES`, retry/deadline logic in `notionFetch`).
- Errors sent to the extension from the host must pass `sanitizeIntegrationError` (token-scrubbed, ≤200 chars).

## Phase → branch map

| Phase | Branch | Tasks |
| --- | --- | --- |
| 1 Structured summary | `feat/structured-summary` | 1–5 |
| 2 Editable prompt | `feat/editable-prompt` | 6–7 |
| 3 Notion action export | `feat/action-export` | 8–12 |

Each phase branches from `main` (Phase 2 from Phase 1's merge, Phase 3 from Phase 2's merge), is TDD'd, reviewed, then merged locally after the owner's manual Chrome checklist.

---

### Task 1: `SessionSummary` schema + `summaryToMarkdown`

**Files:**
- Modify: `packages/shared/src/types.ts` (append after `LlmProvider`)
- Modify: `packages/shared/src/summarize.ts`
- Modify: `packages/shared/src/index.ts` (ensure new symbols are exported; it re-exports `./types.js` and `./summarize.js` already — verify)
- Test: `packages/shared/test/summarize.test.ts` (extend)

**Interfaces:**
- Produces (used by every later task):

```ts
export interface ActionItem {
  id: string;               // crypto.randomUUID(); assigned client-side
  text: string;
  owner?: string;
  due?: string;             // verbatim phrase, never an inferred date
}

export interface SessionSummary {
  version: 1;
  narrative: string;        // markdown paragraphs
  actionItems: ActionItem[];
  decisions: string[];
  usefulInfo: string[];
  generatedAt: string;      // ISO 8601
  model?: string;
  degraded?: true;          // set when JSON extraction failed (raw text fallback)
}

export function actionItemLine(item: ActionItem): string;
// "owner — text (due)"; omits owner/due when absent

export function summaryToMarkdown(s: SessionSummary): string;
```

- [ ] **Step 1: Write failing tests** in `packages/shared/test/summarize.test.ts`:

```ts
import { actionItemLine, summaryToMarkdown, type SessionSummary } from '../src/index.js';

const base: SessionSummary = {
  version: 1,
  narrative: 'We agreed on the Q3 plan.',
  actionItems: [
    { id: 'a1', text: 'Send the deck', owner: 'Sam', due: 'by Friday' },
    { id: 'a2', text: 'Book the room' },
  ],
  decisions: ['Ship v2 in September'],
  usefulInfo: ['Budget code: X-42'],
  generatedAt: '2026-08-28T00:00:00.000Z',
};

describe('actionItemLine', () => {
  it('composes owner — text (due)', () => {
    expect(actionItemLine(base.actionItems[0]!)).toBe('Sam — Send the deck (by Friday)');
  });
  it('is just text when owner/due absent', () => {
    expect(actionItemLine(base.actionItems[1]!)).toBe('Book the room');
  });
  it('handles due without owner', () => {
    expect(actionItemLine({ id: 'x', text: 'Ping legal', due: 'next week' })).toBe('Ping legal (next week)');
  });
});

describe('summaryToMarkdown', () => {
  it('renders all sections with ## headings and checklist items', () => {
    const md = summaryToMarkdown(base);
    expect(md).toContain('## Summary\n\nWe agreed on the Q3 plan.');
    expect(md).toContain('## Action items\n\n- [ ] Sam — Send the deck (by Friday)\n- [ ] Book the room');
    expect(md).toContain('## Decisions\n\n- Ship v2 in September');
    expect(md).toContain('## Useful info\n\n- Budget code: X-42');
    expect(md.endsWith('\n')).toBe(true);
  });
  it('omits empty sections but always emits Summary and Action items', () => {
    const md = summaryToMarkdown({ ...base, decisions: [], usefulInfo: [] });
    expect(md).not.toContain('## Decisions');
    expect(md).not.toContain('## Useful info');
    expect(md).toContain('## Summary');
  });
  it('falls back to placeholders when empty', () => {
    const md = summaryToMarkdown({ ...base, narrative: '', actionItems: [] });
    expect(md).toContain('(no summary)');
    expect(md).toContain('- [ ] None identified');
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @scribetab/shared test -- summarize` — expect FAIL (symbols not exported).

- [ ] **Step 3: Implement.** In `types.ts` add the two interfaces above (verbatim). In `summarize.ts`:

```ts
import type { ActionItem, SessionSummary } from './types.js';

export function actionItemLine(item: ActionItem): string {
  const owner = item.owner?.trim();
  const due = item.due?.trim();
  let line = item.text.trim();
  if (owner) line = `${owner} — ${line}`;
  if (due) line = `${line} (${due})`;
  return line;
}

export function summaryToMarkdown(s: SessionSummary): string {
  const parts: string[] = ['## Summary', '', s.narrative.trim() || '(no summary)', ''];
  const items = s.actionItems.map((i) => `- [ ] ${actionItemLine(i)}`);
  parts.push('## Action items', '', items.length ? items.join('\n') : '- [ ] None identified');
  if (s.decisions.length) {
    parts.push('', '## Decisions', '', s.decisions.map((d) => `- ${d.trim()}`).join('\n'));
  }
  if (s.usefulInfo.length) {
    parts.push('', '## Useful info', '', s.usefulInfo.map((u) => `- ${u.trim()}`).join('\n'));
  }
  return parts.join('\n') + '\n';
}
```

Keep the existing `combineSummaryMarkdown` untouched for now (Task 3 removes it with its callers).

- [ ] **Step 4: Run** the same test command — expect PASS.
- [ ] **Step 5: Commit** `feat(shared): SessionSummary schema and summaryToMarkdown`.

---

### Task 2: structured prompt builder + tolerant JSON parser

**Files:**
- Modify: `packages/shared/src/summarize.ts`
- Test: `packages/shared/test/summarize.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionSummary`, `ActionItem`, existing `clipTranscript`, `DATA_FRAMING`, `ChatMessage`.
- Produces:

```ts
export const DEFAULT_SUMMARY_GUIDANCE: string; // user-visible default guidance text
export function buildStructuredSummaryMessages(transcript: string, guidance?: string): ChatMessage[];
export function parseStructuredSummary(
  raw: string,
  opts: { generatedAt: string; model?: string; newId?: () => string },
): SessionSummary; // never throws
```

- [ ] **Step 1: Write failing tests:**

```ts
import {
  buildStructuredSummaryMessages,
  DEFAULT_SUMMARY_GUIDANCE,
  parseStructuredSummary,
} from '../src/index.js';

const P = { generatedAt: '2026-08-28T00:00:00.000Z', newId: () => 'fixed-id' };

describe('buildStructuredSummaryMessages', () => {
  it('has fixed system contract, guidance, and wrapped transcript', () => {
    const msgs = buildStructuredSummaryMessages('hello world');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('only a JSON object');
    expect(msgs[0]!.content).toContain('"actionItems"');
    expect(msgs[0]!.content).toContain('untrusted data'); // DATA_FRAMING
    expect(msgs[1]!.content).toContain(DEFAULT_SUMMARY_GUIDANCE);
    expect(msgs[1]!.content).toContain('<transcript>\nhello world\n</transcript>');
  });
  it('substitutes custom guidance verbatim, keeping frame fixed', () => {
    const msgs = buildStructuredSummaryMessages('t', 'Focus only on budget talk.');
    expect(msgs[1]!.content).toContain('Focus only on budget talk.');
    expect(msgs[1]!.content).not.toContain(DEFAULT_SUMMARY_GUIDANCE);
    expect(msgs[0]!.content).toContain('only a JSON object'); // contract untouched
    expect(msgs[1]!.content).toContain('<transcript>');
  });
  it('treats whitespace-only guidance as default', () => {
    const msgs = buildStructuredSummaryMessages('t', '   ');
    expect(msgs[1]!.content).toContain(DEFAULT_SUMMARY_GUIDANCE);
  });
  it('clips long transcripts (head+tail)', () => {
    const long = 'x'.repeat(30_000);
    const msgs = buildStructuredSummaryMessages(long);
    expect(msgs[1]!.content).toContain('[... transcript truncated for length ...]');
  });
});

describe('parseStructuredSummary', () => {
  const good = JSON.stringify({
    narrative: 'Short recap.',
    actionItems: [{ text: 'Do a thing', owner: 'Ana' }, { text: 'Other' }],
    decisions: ['Yes to X'],
    usefulInfo: [],
  });

  it('parses clean JSON and assigns ids', () => {
    const s = parseStructuredSummary(good, P);
    expect(s.narrative).toBe('Short recap.');
    expect(s.actionItems).toEqual([
      { id: 'fixed-id', text: 'Do a thing', owner: 'Ana' },
      { id: 'fixed-id', text: 'Other' },
    ]);
    expect(s.decisions).toEqual(['Yes to X']);
    expect(s.degraded).toBeUndefined();
    expect(s.generatedAt).toBe(P.generatedAt);
    expect(s.version).toBe(1);
  });
  it('strips code fences', () => {
    expect(parseStructuredSummary('```json\n' + good + '\n```', P).narrative).toBe('Short recap.');
  });
  it('extracts the outermost object from surrounding prose', () => {
    expect(parseStructuredSummary('Here you go:\n' + good + '\nHope that helps!', P).narrative).toBe('Short recap.');
  });
  it('drops malformed entries and coerces missing arrays', () => {
    const messy = JSON.stringify({
      narrative: 'ok',
      actionItems: [{ text: 'good' }, { notText: true }, 'string-item', { text: '  ' }],
      decisions: ['keep', 42, null],
    });
    const s = parseStructuredSummary(messy, P);
    expect(s.actionItems.map((a) => a.text)).toEqual(['good']);
    expect(s.decisions).toEqual(['keep']);
    expect(s.usefulInfo).toEqual([]);
  });
  it('falls back to degraded raw-text summary on garbage', () => {
    const s = parseStructuredSummary('The meeting was fine, no JSON here.', P);
    expect(s.degraded).toBe(true);
    expect(s.narrative).toBe('The meeting was fine, no JSON here.');
    expect(s.actionItems).toEqual([]);
  });
  it('falls back when JSON parses but is not an object', () => {
    expect(parseStructuredSummary('[1,2,3]', P).degraded).toBe(true);
  });
  it('ignores owner/due that are not strings and trims fields', () => {
    const s = parseStructuredSummary(
      JSON.stringify({ narrative: ' n ', actionItems: [{ text: ' t ', owner: 3, due: ' Fri ' }] }),
      P,
    );
    expect(s.narrative).toBe('n');
    expect(s.actionItems[0]).toEqual({ id: 'fixed-id', text: 't', due: 'Fri' });
  });
});
```

- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** in `summarize.ts`:

```ts
export const DEFAULT_SUMMARY_GUIDANCE =
  'Summarize the meeting in 1–3 short paragraphs covering outcomes and open questions. ' +
  'Extract concrete action items, naming an owner only when one was actually said and quoting due dates verbatim. ' +
  'List decisions that were explicitly made, and capture useful details worth keeping (links, numbers, names).';

const JSON_CONTRACT =
  'You analyze meeting transcripts. Reply with only a JSON object — no prose, no code fences — matching exactly: ' +
  '{"narrative": string (markdown paragraphs), ' +
  '"actionItems": [{"text": string, "owner"?: string, "due"?: string}], ' +
  '"decisions": string[], "usefulInfo": string[]}. ' +
  'Use empty arrays when a category has nothing. Never invent owners or dates. ' +
  DATA_FRAMING;

export function buildStructuredSummaryMessages(transcript: string, guidance?: string): ChatMessage[] {
  const g = guidance?.trim() || DEFAULT_SUMMARY_GUIDANCE;
  return [
    { role: 'system', content: JSON_CONTRACT },
    { role: 'user', content: `${g}\n\n${wrapTranscript(transcript)}` },
  ];
}

function extractJsonObject(text: string): unknown | undefined {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function toActionItems(v: unknown, newId: () => string): ActionItem[] {
  if (!Array.isArray(v)) return [];
  const out: ActionItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) continue;
    const owner = typeof rec.owner === 'string' && rec.owner.trim() ? rec.owner.trim() : undefined;
    const due = typeof rec.due === 'string' && rec.due.trim() ? rec.due.trim() : undefined;
    out.push({ id: newId(), text, ...(owner ? { owner } : {}), ...(due ? { due } : {}) });
  }
  return out;
}

export function parseStructuredSummary(
  raw: string,
  opts: { generatedAt: string; model?: string; newId?: () => string },
): SessionSummary {
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const common = {
    version: 1 as const,
    generatedAt: opts.generatedAt,
    ...(opts.model ? { model: opts.model } : {}),
  };
  const obj = extractJsonObject(raw);
  if (!obj) {
    return {
      ...common,
      narrative: parseSummary(raw),
      actionItems: [],
      decisions: [],
      usefulInfo: [],
      degraded: true,
    };
  }
  const rec = obj as Record<string, unknown>;
  return {
    ...common,
    narrative: typeof rec.narrative === 'string' ? rec.narrative.trim() : '',
    actionItems: toActionItems(rec.actionItems, newId),
    decisions: stringArray(rec.decisions),
    usefulInfo: stringArray(rec.usefulInfo),
  };
}
```

- [ ] **Step 4: Run** — expect PASS (full shared suite: `pnpm --filter @scribetab/shared test`).
- [ ] **Step 5: Commit** `feat(shared): structured summary prompt builder and tolerant parser`.

---

### Task 3: `summarizeMeeting` returns `SessionSummary`; delete two-call flow

**Files:**
- Modify: `packages/shared/src/summarize.ts`
- Test: `packages/shared/test/summarize.test.ts`

**Interfaces:**
- Produces:

```ts
export async function summarizeMeeting(
  complete: (messages: ChatMessage[]) => Promise<string>,
  segments: Pick<TranscriptSegment, 'speaker' | 'text'>[],
  opts?: { guidance?: string; model?: string; generatedAt?: string; newId?: () => string },
): Promise<SessionSummary | undefined>; // undefined when transcript is empty
```

- Deletes: `buildSummaryMessages`, `buildActionItemMessages`, `parseActionItems`, `combineSummaryMarkdown` (grep the whole repo for callers first; update their tests — `parseSummary` STAYS, it is used by the fallback).

- [ ] **Step 1: Write failing tests** (replace the old `summarizeMeeting` tests):

```ts
describe('summarizeMeeting (structured)', () => {
  const segs = [
    { speaker: 'Ana', text: 'We decided to ship.' },
    { speaker: 'Bo', text: 'I will send the notes.' },
  ];
  const reply = JSON.stringify({
    narrative: 'Shipped decision.',
    actionItems: [{ text: 'Send the notes', owner: 'Bo' }],
    decisions: ['Ship it'],
    usefulInfo: [],
  });

  it('makes exactly one LLM call and returns a SessionSummary', async () => {
    const calls: ChatMessage[][] = [];
    const s = await summarizeMeeting(async (m) => { calls.push(m); return reply; }, segs, {
      generatedAt: 'T', newId: () => 'i',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]!.content).toContain('Ana: We decided to ship.');
    expect(s?.narrative).toBe('Shipped decision.');
    expect(s?.actionItems[0]?.owner).toBe('Bo');
  });
  it('returns undefined for an empty transcript without calling the LLM', async () => {
    const s = await summarizeMeeting(async () => { throw new Error('no'); }, [{ speaker: undefined, text: '  ' }]);
    expect(s).toBeUndefined();
  });
  it('passes guidance through', async () => {
    let userMsg = '';
    await summarizeMeeting(async (m) => { userMsg = m[1]!.content; return reply; }, segs, { guidance: 'Budget only.' });
    expect(userMsg).toContain('Budget only.');
  });
  it('degrades instead of throwing on non-JSON output', async () => {
    const s = await summarizeMeeting(async () => 'plain text', segs, { generatedAt: 'T' });
    expect(s?.degraded).toBe(true);
    expect(s?.narrative).toBe('plain text');
  });
});
```

- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement:**

```ts
export async function summarizeMeeting(
  complete: (messages: ChatMessage[]) => Promise<string>,
  segments: Pick<TranscriptSegment, 'speaker' | 'text'>[],
  opts: { guidance?: string; model?: string; generatedAt?: string; newId?: () => string } = {},
): Promise<SessionSummary | undefined> {
  const transcript = transcriptPlain(segments);
  if (!transcript) return undefined;
  const raw = await complete(buildStructuredSummaryMessages(transcript, opts.guidance));
  return parseStructuredSummary(raw, {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    model: opts.model,
    newId: opts.newId,
  });
}
```

Delete the four legacy exports and their tests; fix any other callers found by `grep -rn "combineSummaryMarkdown\|buildSummaryMessages\|buildActionItemMessages\|parseActionItems" --include="*.ts" --include="*.tsx" apps packages`.

- [ ] **Step 4: Run** full shared suite + `pnpm -r typecheck` — expect PASS (extension will fail typecheck if it used deleted symbols — fix in Task 4; if so, run shared-only here and note it).
- [ ] **Step 5: Commit** `feat(shared)!: summarizeMeeting returns structured SessionSummary in one LLM call`.

---

### Task 4: extension stores `summary` + derived `summaryMarkdown`

**Files:**
- Modify: `apps/extension/utils/sessionStore.ts` (extend `StoredSession`)
- Modify: `apps/extension/utils/intelligence.ts`
- Test: `apps/extension/test/intelligence.test.ts` (extend existing harness/mocks)

**Interfaces:**
- Consumes: `summarizeMeeting`, `summaryToMarkdown`, `SessionSummary` from shared.
- Produces: `StoredSession.summary?: SessionSummary` (side panel reads it in Task 5; export reads `summary.actionItems` in Phase 3).

- [ ] **Step 1: Extend `StoredSession`:**

```ts
export type StoredSession = MeetingSession & {
  summaryMarkdown?: string;
  summary?: SessionSummary;
  // ...existing fields unchanged
};
```

- [ ] **Step 2: Write failing tests** in `intelligence.test.ts`, following that file's existing mock pattern for `chrome.*`, stores, and provider (read it first; reuse its helpers). New cases:

```ts
it('stores structured summary and derived markdown after finalize', async () => {
  // provider mock returns the JSON reply fixture from Task 3
  await runFinalizeIntelligence(sessionId, settingsWithLlm);
  const row = await getSession(sessionId);
  expect(row?.summary?.actionItems).toHaveLength(1);
  expect(row?.summaryMarkdown).toContain('## Action items');
  expect(row?.summaryMarkdown).toContain('- [ ] Bo — Send the notes');
  expect(row?.intelligence).toBeNull();
});

it('stores degraded summary when the model returns prose', async () => {
  // provider mock returns 'plain text'
  await runFinalizeIntelligence(sessionId, settingsWithLlm);
  const row = await getSession(sessionId);
  expect(row?.summary?.degraded).toBe(true);
  expect(row?.summaryMarkdown).toContain('plain text');
});
```

- [ ] **Step 3: Run** `pnpm --filter <extension-pkg> test -- intelligence` — expect FAIL.
- [ ] **Step 4: Implement** in `intelligence.ts` — replace the summary block inside `runFinalizeIntelligence`:

```ts
let summary: SessionSummary | undefined;
// inside the try after building `complete`:
try {
  summary = await summarizeMeeting(complete, forLlm, {
    model: settings.llmModel.trim() || undefined,
  });
  intelligence = null;
} catch {
  intelligence = 'pending';
}
// final updateSession patch:
await updateSession(sessionId, {
  costUsd: costUsd === undefined ? existing?.costUsd ?? null : costUsd,
  intelligence,
  ...(summary ? { summary, summaryMarkdown: summaryToMarkdown(summary) } : {}),
});
```

- [ ] **Step 5: Run** extension tests + `pnpm -r typecheck` — expect PASS.
- [ ] **Step 6: Commit** `feat(extension): store structured SessionSummary with derived markdown`.

---

### Task 5: side-panel structured rendering (render-only)

**Files:**
- Modify: `apps/extension/entrypoints/sidepanel/main.tsx` (session detail view, around the `open.summaryMarkdown` article at ~line 450)

**Interfaces:**
- Consumes: `open.summary` (`SessionSummary`), falls back to `open.summaryMarkdown`.
- Produces: a `SummaryView({ summary })` Preact component in the same file (kept local; file is ~560 lines, acceptable). No export button yet.

- [ ] **Step 1: Implement** — replace the summary `<article>` block:

```tsx
{open.summary ? (
  <SummaryView summary={open.summary} />
) : open.summaryMarkdown ? (
  <article style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 8, fontSize: 13, marginBottom: 12 }}>
    {open.summaryMarkdown}
  </article>
) : null}
```

with, alongside `SegmentList`:

```tsx
function SummaryView({ summary }: { summary: SessionSummary }) {
  const sec: preact.JSX.CSSProperties = { fontSize: 13, margin: '0 0 4px', fontWeight: 600 };
  return (
    <div style={{ background: '#f6f6f6', padding: 8, fontSize: 13, marginBottom: 12 }}>
      {summary.degraded && (
        <p style={{ color: '#a60', fontSize: 12, margin: '0 0 6px' }}>
          Structured extraction failed — showing plain summary.
        </p>
      )}
      {summary.narrative && <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{summary.narrative}</p>}
      {summary.actionItems.length > 0 && (
        <>
          <h2 style={sec}>Action items</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
            {summary.actionItems.map((a) => (
              <li key={a.id}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <input type="checkbox" checked disabled />
                  <span>{actionItemLine(a)}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.decisions.length > 0 && (
        <>
          <h2 style={sec}>Decisions</h2>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {summary.decisions.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </>
      )}
      {summary.usefulInfo.length > 0 && (
        <>
          <h2 style={sec}>Useful info</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {summary.usefulInfo.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
```

(Checkboxes are disabled/decorative in this phase; Phase 3 makes them live. Match the file's existing inline-style idiom; import `actionItemLine` and `SessionSummary` from `@scribetab/shared`.)

- [ ] **Step 2: Verify** `pnpm --filter <extension-pkg> typecheck && pnpm --filter <extension-pkg> build` (find the build script name in its package.json) — expect clean.
- [ ] **Step 3: Commit** `feat(sidepanel): sectioned structured-summary rendering`.

**Phase 1 owner checklist (manual, real Chrome):**
1. Record a short meeting with an LLM provider configured. Expect: detail view shows narrative + Action items checkboxes + Decisions/Useful info sections.
2. Open an old session. Expect: plain markdown summary renders as before.
3. Regenerate summary. Expect: structured view replaces markdown view.
4. Export .md. Expect: `## Summary` / `## Action items` sections present.

---

### Task 6: `summaryPrompt` setting

**Files:**
- Modify: `apps/extension/utils/settings.ts`
- Test: `apps/extension/test/settings.test.ts` (extend)

**Interfaces:**
- Produces: `Settings.summaryPrompt: string` (`''` = default guidance).

- [ ] **Step 1: Failing tests:**

```ts
it('defaults summaryPrompt to empty and preserves stored values', () => {
  expect(normalizeSettings(undefined).summaryPrompt).toBe('');
  expect(normalizeSettings({ summaryPrompt: 'Budget focus.' } as Partial<Settings>).summaryPrompt).toBe('Budget focus.');
});
it('coerces a non-string summaryPrompt to empty', () => {
  expect(normalizeSettings({ summaryPrompt: 42 as unknown as string }).summaryPrompt).toBe('');
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3:** add `summaryPrompt: string` to `Settings` + `DEFAULT_SETTINGS` (`''`), and in `normalizeSettings` after `merged` is built: `if (typeof merged.summaryPrompt !== 'string') merged.summaryPrompt = '';`
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(extension): summaryPrompt setting`.

---

### Task 7: wire guidance through + options UI

**Files:**
- Modify: `apps/extension/utils/intelligence.ts` (pass `guidance: settings.summaryPrompt` in the `summarizeMeeting` opts)
- Modify: `apps/extension/entrypoints/options/main.tsx`
- Test: `apps/extension/test/intelligence.test.ts` (one case)

**Interfaces:** consumes `DEFAULT_SUMMARY_GUIDANCE` from shared for the placeholder/reset.

- [ ] **Step 1: Failing test** — provider mock captures messages; with `settingsWithLlm.summaryPrompt = 'Focus on risks.'` expect the captured user message to contain `Focus on risks.`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** add `guidance: settings.summaryPrompt` to the opts object in `runFinalizeIntelligence`.
- [ ] **Step 4: Run** — PASS. Commit `feat(extension): user guidance flows into summary prompt`.
- [ ] **Step 5: Options UI** — in the LLM section of `options/main.tsx` (after the model field), following the file's existing row/label idiom:

```tsx
<label style={row} for="summaryPrompt">Summary guidance</label>
<textarea
  id="summaryPrompt"
  rows={5}
  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
  placeholder={DEFAULT_SUMMARY_GUIDANCE}
  value={s.summaryPrompt}
  onInput={(e) => setS({ ...s, summaryPrompt: (e.currentTarget as HTMLTextAreaElement).value })}
/>
<p style={{ fontSize: 11, color: '#666', margin: '2px 0 8px' }}>
  Customize what the summary focuses on. Output format and transcript handling are fixed.
  <button type="button" style={{ marginLeft: 8 }} onClick={() => setS({ ...s, summaryPrompt: '' })}>
    Reset to default
  </button>
</p>
```

Ensure Save persists it (`saveSettings` already writes the whole object; trim-to-empty on save: `summaryPrompt: s.summaryPrompt.trim() ? s.summaryPrompt : ''` in the save handler's settings object if the handler builds one explicitly — check how other fields are saved and match).

- [ ] **Step 6: Verify** typecheck + build. **Step 7: Commit** `feat(options): editable summary guidance with reset`.

**Phase 2 owner checklist:**
1. Options → set guidance "One-sentence summary only. No action items." Save. Regenerate a session summary. Expect: obviously shorter narrative.
2. Reset to default → Save → Regenerate. Expect: normal summary again.

---

### Task 8: export protocol types (shared)

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: none (types only; verified by consumers' tests)

**Interfaces — produced (verbatim):**

```ts
export type ExportActionsMessage = {
  type: 'export_actions';
  protocolVersion: 1;
  sessionId: string;
  items: ActionItem[];
};

export interface ExportActionsAck {
  ok: boolean;
  sessionId: string;
  error?: string;                 // transport/config-level failure
  results: { id: string; ok: boolean; error?: string }[];
  pageUrl?: string;
}

export type HostMessage = HostSyncMessage | ExportActionsMessage;
```

- [ ] **Step 1:** Add the types; run `pnpm -r typecheck`. **Step 2: Commit** `feat(shared): export_actions protocol types`.

---

### Task 9: host — `to_do` blocks + `appendActionItems` + `notionActions.json`

**Files:**
- Modify: `apps/native-host/src/paths.ts` (add `notionActionsPath`, mirroring `notionPagesPath`)
- Modify: `apps/native-host/src/notion.ts`
- Test: `apps/native-host/test/notion.test.ts` (extend; reuse its existing mock-fetch helpers — read them first)

**Interfaces:**
- Consumes: `ActionItem`, `actionItemLine` from shared; existing `notionFetch`, `batchBlocks`, `chunkRichText`, `loadNotionPageMap`, `createNotionPage`.
- Produces:

```ts
export type NotionActionRecord = {
  pageId: string;
  headingAdded: boolean;
  items: Record<string, { ok: true; at: string }>; // keyed by ActionItem.id
};
export type NotionActionMap = Record<string, NotionActionRecord>; // keyed by sessionId

export async function loadNotionActionMap(env?, platform?): Promise<NotionActionMap>;
export async function saveNotionActionMap(map, env?, platform?): Promise<void>;

export function actionItemBlocks(items: ActionItem[]): NotionBlock[]; // one to_do per item

export async function appendActionItems(opts: {
  token: string;
  pageId: string;
  sessionId: string;
  items: ActionItem[];
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deadline?: number;
  now?: () => string;
}): Promise<{ results: { id: string; ok: boolean; error?: string }[] }>;
```

Extend the `NotionBlock` union with:

```ts
| { object: 'block'; type: 'to_do'; to_do: { rich_text: NotionRichText[]; checked: boolean } }
```

- [ ] **Step 1: Failing tests** (mock fetch as the existing notion tests do):

```ts
describe('actionItemBlocks', () => {
  it('maps items to unchecked to_do blocks with composed lines', () => {
    const blocks = actionItemBlocks([{ id: 'a', text: 'Send deck', owner: 'Sam', due: 'Fri' }]);
    expect(blocks[0]).toMatchObject({
      type: 'to_do',
      to_do: { checked: false, rich_text: [{ text: { content: 'Sam — Send deck (Fri)' } }] },
    });
  });
  it('chunks >2000-char items across rich_text parts in one block', () => {
    const blocks = actionItemBlocks([{ id: 'a', text: 'x'.repeat(4100) }]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { to_do: { rich_text: unknown[] } }).to_do.rich_text.length).toBe(3);
  });
});

describe('appendActionItems', () => {
  // helper: fetchOk = () => Response 200 with '{}' body; fetchFail on Nth call
  it('appends heading once, marks items exported, and is idempotent', async () => {
    // call 1: two items → expect one PATCH /blocks/PAGE/children whose body has
    //   heading_2 'Action items' + two to_do blocks; both marked ok in notionActions.json
    // call 2: same two items again → zero fetch calls, both results ok:true
  });
  it('skips only already-exported items on a partial retry', async () => {
    // map pre-seeded with item a1 ok → request body contains only a2's to_do, no heading (headingAdded true)
  });
  it('marks nothing exported when the batch request fails', async () => {
    // fetch returns 500 → results all ok:false with sanitized message; map unchanged
  });
  it('splits >100 blocks into batches and marks per landed batch', async () => {
    // 120 items, first PATCH 200, second PATCH 500 →
    //   first batch's items ok:true (and persisted), second batch's ok:false
  });
});
```

Write these as real tests (the comments above describe the arrange/assert content — implement them fully, using a temp dir via the test helpers' env override for `notionActions.json`, as `notionPagesPath` tests do).

- [ ] **Step 2: Run** `pnpm --filter <host-pkg> test -- notion` — FAIL.
- [ ] **Step 3: Implement.** `notionActionsPath` mirrors `notionPagesPath` (same dir, file `notionActions.json`). Load/save mirror `loadNotionPageMap`/`saveNotionPageMap` (tolerant parse → `{}`, atomic 0600 write). Core:

```ts
export function actionItemBlocks(items: ActionItem[]): NotionBlock[] {
  return items.map((item) => ({
    object: 'block' as const,
    type: 'to_do' as const,
    to_do: { rich_text: chunkRichText(actionItemLine(item)), checked: false },
  }));
}

export async function appendActionItems(opts): Promise<{ results: ... }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = opts.deadline ?? Date.now() + NOTION_INTEGRATION_BUDGET_MS;
  const now = opts.now ?? (() => new Date().toISOString());
  const map = await loadNotionActionMap(opts.env, opts.platform);
  const rec: NotionActionRecord = map[opts.sessionId] ?? { pageId: opts.pageId, headingAdded: false, items: {} };
  rec.pageId = opts.pageId;

  const results: { id: string; ok: boolean; error?: string }[] = [];
  const pending = opts.items.filter((i) => {
    if (rec.items[i.id]?.ok) { results.push({ id: i.id, ok: true }); return false; }
    return true;
  });
  if (pending.length === 0) return { results };

  const blocks: NotionBlock[] = [];
  const blockOwners: (string | null)[] = []; // parallel: item id per block, null for heading
  if (!rec.headingAdded) { blocks.push(heading2('Action items')); blockOwners.push(null); }
  for (const item of pending) { blocks.push(...actionItemBlocks([item])); blockOwners.push(item.id); }

  // Batch while keeping blockOwners aligned: batch indices, not blocks, so each
  // batch knows which item ids it carries.
  const batches = batchBlocks(blocks.map((b, i) => ({ b, i })));
  let failed: string | undefined;
  for (const batch of batches) {
    if (failed === undefined) {
      try {
        const res = await notionFetch(`/blocks/${opts.pageId}/children`, opts.token,
          { method: 'PATCH', body: JSON.stringify({ children: batch.map((x) => x.b) }) },
          fetchImpl, deadline);
        if (!res.ok) throw notionError(res.status, await res.text().catch(() => ''));
        for (const x of batch) {
          const id = blockOwners[x.i];
          if (id === null) rec.headingAdded = true;
          else { rec.items[id!] = { ok: true, at: now() }; results.push({ id: id!, ok: true }); }
        }
        map[opts.sessionId] = rec;
        await saveNotionActionMap(map, opts.env, opts.platform); // persist per landed batch
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
    }
    if (failed !== undefined) {
      for (const x of batch) {
        const id = blockOwners[x.i];
        if (id !== null && !rec.items[id!]?.ok) results.push({ id: id!, ok: false, error: failed });
      }
    }
  }
  return { results };
}
```

(Adjust to real code — the snippet is the exact algorithm: filter exported → heading-once → owner-aligned batching → mark-and-persist per landed batch → per-item errors after first failure. `heading2` is already in the file.)

- [ ] **Step 4: Run** — PASS (full host suite).
- [ ] **Step 5: Commit** `feat(host): append action items as Notion to_do blocks with idempotency map`.

---

### Task 10: host — dispatch `export_actions`

**Files:**
- Modify: `apps/native-host/src/protocol.ts` (`NativeSyncHost.dispatch`)
- Test: `apps/native-host/test/nativeSyncHost.test.ts` (extend; it already drives `NativeSyncHost` with a fake stdout — reuse)

**Interfaces:**
- Consumes: `ExportActionsMessage`, `ExportActionsAck`, `appendActionItems`, `loadNotionPageMap`, `createNotionPage`, `getMeeting` (from `meetings.js`), `loadConfig`, `sanitizeIntegrationError`.
- Produces: on an `export_actions` message the host writes exactly one `ExportActionsAck` native message.

Handler logic (new `case 'export_actions'` in `dispatch`; it must NOT touch `this.inflight` or `this.silenced` — export is independent of any sync):

1. Validate `sessionId` and `items` (array of `{id,text}` strings; reject otherwise with `ok:false`).
2. `loadConfig`; if `!cfg.notionEnabled || !cfg.notion?.token || !cfg.notion?.parentPageId` → ack `{ ok:false, sessionId, error: 'Notion is not configured on the native host (run: scribetab-host config set …)', results: [] }`.
3. Resolve page: `loadNotionPageMap()[sessionId]`. If no `ok` record → `getMeeting(meetingsDir(env), sessionId)`; if meeting missing → ack `ok:false, error: 'Meeting not synced to disk yet — stop the recording and wait for sync, then retry'`; else `createNotionPage({...})` (this archives partials and writes the map) and use its `pageId`.
4. `appendActionItems({ token, pageId, sessionId, items, fetchImpl: this.opts.fetchImpl, env: this.env, platform: this.opts.platform })`.
5. Ack `{ ok: true, sessionId, results, pageUrl: `https://www.notion.so/${pageId.replace(/-/g, '')}` }`.
6. All errors → ack `ok:false` with `sanitizeIntegrationError(msg, token)`; per-item `results[].error` likewise sanitized inside `appendActionItems`' caller before acking.

- [ ] **Step 1: Failing tests** (fake stdout capture, temp meetings dir, mocked fetch):
  - unconfigured Notion → single ack `ok:false`, error mentions config, no fetch calls;
  - configured + page already in map + 2 items → ack `ok:true` with 2 ok results; the PATCH body contained the heading + 2 to_dos;
  - unknown session (no page, no meeting on disk) → `ok:false`, error mentions sync;
  - export does not disturb an in-flight sync: send `sync_begin`, then `export_actions`, then `sync_end` — sync still commits and acks ok (export ack interleaves; assert by message `type`/shape: acks with `results` are export acks).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** per the numbered logic. Type `dispatch`'s parameter as `HostMessage`.
- [ ] **Step 4: Run** full host suite — PASS.
- [ ] **Step 5: Commit** `feat(host): export_actions native message`.

---

### Task 11: extension — export transport + session export cache

**Files:**
- Create: `apps/extension/utils/actionExport.ts`
- Modify: `apps/extension/utils/sessionStore.ts` (`StoredSession.actionExports`)
- Modify: `apps/extension/entrypoints/background.ts` (new `EXPORT_ACTIONS` case beside `REGENERATE_SUMMARY` at ~line 646)
- Test: `apps/extension/test/actionExport.test.ts` (new; mirror `apps/extension/test/nativeSync.test.ts`'s fake-port pattern)

**Interfaces:**
- Consumes: `ExportActionsMessage`, `ExportActionsAck`, `ActionItem`; `NATIVE_HOST_NAME` from `nativeSync.ts`.
- Produces:

```ts
// StoredSession gains:
actionExports?: Record<string, { destination: 'notion'; at: string }>; // keyed by ActionItem.id

// actionExport.ts
export const EXPORT_ACK_TIMEOUT_MS = 90_000; // Notion budget (60s) + margin
export async function exportActionsViaHost(
  sessionId: string,
  items: ActionItem[],
  opts?: { ackTimeoutMs?: number },
): Promise<ExportActionsAck>;
// Background message: { target:'background', type:'EXPORT_ACTIONS', sessionId, itemIds: string[] }
// → responds with ExportActionsAck
```

- [ ] **Step 1: Failing tests** for `exportActionsViaHost` with a fake port (post `export_actions`, receive ack, resolve; disconnect-before-ack → `ok:false` with host-missing classification via `isHostMissingError`; timeout → `ok:false` timeout error) and for the background handler contract: given a session whose `summary` has 3 items and `itemIds` selecting 2, the posted message contains exactly those 2 items; on `ok` results the session's `actionExports` is patched with `{ destination:'notion', at: <ack time> }` per ok id.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `exportActionsViaHost`: `chrome.runtime.connectNative(NATIVE_HOST_NAME)`, post one `export_actions` message, resolve on first ack (settle pattern copied from `nativeSync.ts`'s `streamToPort`, minus audio/follow-up), timeout via `EXPORT_ACK_TIMEOUT_MS`, map connect/disconnect errors to `{ ok:false, sessionId, error, results: [] }`. Background case:

```ts
case 'EXPORT_ACTIONS': {
  const { sessionId, itemIds } = msg as { sessionId: string; itemIds: string[] };
  void (async () => {
    const session = await getSession(sessionId);
    const all = session?.summary?.actionItems ?? [];
    const wanted = new Set(itemIds);
    const items = all.filter((i) => wanted.has(i.id));
    if (!session || items.length === 0) {
      sendResponse({ ok: false, sessionId, error: 'No matching action items', results: [] });
      return;
    }
    const ack = await exportActionsViaHost(sessionId, items);
    const okIds = ack.results.filter((r) => r.ok).map((r) => r.id);
    if (okIds.length) {
      const at = new Date().toISOString();
      const patch = { ...(session.actionExports ?? {}) };
      for (const id of okIds) patch[id] = { destination: 'notion' as const, at };
      await updateSession(sessionId, { actionExports: patch });
    }
    sendResponse(ack);
  })();
  return true; // async response — match the file's existing pattern for async cases
}
```

- [ ] **Step 4: Run** extension tests — PASS. **Step 5: Commit** `feat(extension): action-item export transport and export cache`.

---

### Task 12: side-panel export UI

**Files:**
- Modify: `apps/extension/entrypoints/sidepanel/main.tsx` (`SummaryView` from Task 5 + detail view)

**Behavior (implement exactly):**
- `SummaryView` gains props `{ summary, exports, busy, onExport }` where `exports = open.actionExports ?? {}`.
- Selection state: `const [sel, setSel] = useState<Set<string>>` initialized (and re-initialized when `open.id` or `summary.generatedAt` changes) to all item ids NOT in `exports`.
- Per item: exported → disabled unchecked checkbox + `exported` badge (`<span style={{ fontSize: 10, color: '#2a7', border: '1px solid #2a7', borderRadius: 3, padding: '0 3px' }}>exported</span>`); failed-last-try (from a `lastResults` state map set after each export ack) → item's error in crimson 11px under the line; otherwise → live checkbox toggling membership in `sel`.
- Button under the list: `Export {sel.size} to Notion` (disabled when `busy || sel.size === 0`); after an ack with failures, label becomes `Retry {failedCount} failed` and selection resets to the failed ids.
- `onExport` in the detail view sends `{ target:'background', type:'EXPORT_ACTIONS', sessionId: open.id, itemIds: [...sel] }`, then `await refreshOpen(open.id)`; transport-level `ok:false` errors go to the existing `actionError` row.
- Regenerate guard: if `open.summary` exists and `open.actionExports` has any entry, `regenerateSummary` first calls `confirm('Regenerating replaces the action items — export history won't carry over. Continue?')` and aborts when declined.

- [ ] **Step 1: Implement** the above. **Step 2:** typecheck + build clean. **Step 3: Commit** `feat(sidepanel): checkbox-selected export of action items to Notion`.

**Phase 3 owner checklist:**
1. Host configured (`scribetab-host config set notionEnabled true`, token, parentPageId). Record + finalize a meeting. Expect: Notion page appears (existing behavior).
2. Detail view → uncheck one item → Export. Expect: button shows correct count; after a beat, exported badges on sent items; Notion page has an "Action items" heading with unchecked to-dos reading `owner — text (due)`.
3. Click Export again with the remaining item. Expect: only that one is added; no duplicates of the previous ones; heading not duplicated.
4. Break the token (`config set notion.token bad`). Export from a new session. Expect: readable error in the panel, no token text in it. Fix token, retry works.
5. Disable native host in extension options / uninstall host. Expect: export shows the host-missing message.
6. Regenerate a summary with exported items. Expect: confirmation dialog; after confirming, fresh items without badges.

---

## Self-review notes (completed)

- Spec coverage: schema (T1–T2), one-call + fallback (T2–T3), derived markdown compatibility (T1, T4), editable guidance-only prompt (T2, T6–T7), exporter interface + native transport (T11), `to_do` mapping + heading-once + idempotency + per-batch partials (T9), host dispatch + sync-independence + sanitized errors (T10), checkbox UI/badges/retry/regenerate-warning (T5, T12). MCP-client/Obsidian exporters and force-resend: explicitly out of scope per spec.
- Types cross-checked: `SessionSummary`/`ActionItem` (T1) ⇄ parser (T2) ⇄ `summarizeMeeting` (T3) ⇄ `StoredSession.summary` (T4) ⇄ `ExportActionsMessage.items` (T8) ⇄ `appendActionItems` (T9) ⇄ background `itemIds` filter (T11).
- Executors must read neighboring test files first and reuse existing mock helpers rather than inventing new harnesses.
