# Structured Summary + Action-Item Export — Design

Date: 2026-08-27
Status: Approved (owner sign-off on the four open decisions, see below)

## Goal

Turn the session summary from a single markdown blob into structured data
(narrative, action items, decisions, useful info), let the user customize the
summarization prompt, and export user-selected action items to the user's
note-taker. ScribeTab does not track tasks — it is an intermediary: the
note-taker owns the to-dos. Notion is the first destination; the export layer
is destination-agnostic so others (Obsidian, MCP-based tools) plug in later.

## Owner decisions (locked)

1. **Destination:** action items are appended to the session's own Notion page
   (created via the existing page sync if missing). Not a shared page, not a
   database.
2. **Transport:** export v1 requires the native host. The extension never holds
   the Notion token; the host's existing hardened Notion client does the work.
3. **LLM calls:** one structured-JSON call replaces the current two-call
   (summary + action items) flow. On unparseable output, fall back to raw text
   as the narrative.
4. **Prompt editability:** the user edits only the guidance section. The JSON
   output contract, injection framing, and transcript wrapper are fixed.

## Current state (what this builds on)

- `packages/shared/src/summarize.ts` — two hardcoded chat calls producing
  markdown; `summaryMarkdown` stored on the session
  (`apps/extension/utils/sessionStore.ts`), rendered pre-wrap in the side panel.
- `apps/extension/utils/intelligence.ts` — background orchestration: redaction,
  cost accounting, `pending` / `needs-permission` states, retry.
- `apps/native-host/src/notion.ts` — direct Notion API client with batching
  (≤100 blocks / ≤400KB), 429 retry, timeout budget, token-scrubbed errors, and
  a `notionPages.json` idempotency map (`ok` / `partial` per session).
- `apps/native-host/src/integrations.ts` — best-effort post-sync integrations
  (Obsidian copy, Notion page), never fail the sync ack.
- `apps/native-host/src/mcp.ts` — read-only MCP server for external agents;
  not a write channel and unchanged by this design.
- LLM chat providers are `openai` and `custom` only
  (`packages/shared/src/llm/index.ts`). Both are plain chat completions, so the
  structured output contract is prompt-and-parse, not a provider JSON mode.

## Part 1 — Structured summary

### Schema

```ts
// packages/shared/src/types.ts
export interface SessionSummary {
  version: 1;
  narrative: string;        // markdown paragraphs
  actionItems: ActionItem[];
  decisions: string[];
  usefulInfo: string[];     // links, numbers, names worth keeping
  generatedAt: string;      // ISO 8601
  model?: string;           // llm model id used, when known
}

export interface ActionItem {
  id: string;               // crypto.randomUUID(); stable for export tracking
  text: string;
  owner?: string;           // only when a name was actually said
  due?: string;             // verbatim phrase ("by Friday"); never inferred dates
}
```

- `StoredSession` gains `summary?: SessionSummary`.
- `summaryMarkdown` remains and is **derived** from `summary` via a new
  `summaryToMarkdown(summary): string` in shared. Everything downstream
  (native sync, Obsidian, Notion page body, md/txt/NotebookLM exports) keeps
  consuming `summaryMarkdown` unchanged.
- No migration: old sessions with only `summaryMarkdown` render as today; the
  structured view appears after the user regenerates.

### LLM contract

- Single chat call. The model is instructed to reply with **only** a JSON
  object: `{ "narrative": string, "actionItems": [{ "text": string,
  "owner"?: string, "due"?: string }], "decisions": string[],
  "usefulInfo": string[] }`. Item `id`s are assigned client-side after parsing
  (the model never generates ids).
- Parsing is tolerant: strip code fences, extract the outermost `{…}`, then
  validate field-by-field with safe defaults (missing array → `[]`, non-string
  entries dropped).
- **Fallback:** if no valid JSON object can be extracted, store
  `narrative = parseSummary(raw)`, empty arrays elsewhere, and set a
  `degraded: true` flag on the stored summary so the UI can say "structured
  extraction failed — showing plain summary". The call is not retried
  automatically (the user has Regenerate).
- Existing behavior carries over unchanged: transcript head+tail clipping
  (`SUMMARY_TRANSCRIPT_CHAR_LIMIT`), untrusted-transcript framing
  (`DATA_FRAMING`), redaction before the call, token-estimate cost accounting
  in `intelligence.ts` (now one call's worth).

### Files touched

- `packages/shared/src/summarize.ts` — new `buildStructuredSummaryMessages`,
  `parseStructuredSummary`, `summaryToMarkdown`; `summarizeMeeting` returns
  `SessionSummary`. The old two-call builders are deleted once callers move.
- `packages/shared/src/types.ts` — schema above.
- `apps/extension/utils/intelligence.ts` — store `summary` + derived
  `summaryMarkdown`.
- `apps/extension/utils/sessionStore.ts` — `summary` field on `StoredSession`.

## Part 2 — Editable prompt

- New setting `summaryPrompt: string` in `apps/extension/utils/settings.ts`
  (`''` = use default). Stored in `chrome.storage.local` with the rest.
- Prompt assembly (in shared, pure function):
  1. fixed system message: role, JSON output contract, `DATA_FRAMING`;
  2. **editable guidance** — the user's text, or the default guidance
     ("summarize decisions, open questions, outcomes; extract action items
     with owners when named; …");
  3. fixed `<transcript>…</transcript>` wrapper.
- Options page (`apps/extension/entrypoints/options/main.tsx`): a textarea
  prefilled with the effective guidance, a "Reset to default" button (clears
  the setting), and a caption: "Customize what the summary focuses on. Output
  format and transcript handling are fixed." Saving an empty/whitespace value
  is equivalent to reset.
- The guidance is inserted verbatim into the user message; because the schema
  contract lives in the fixed system message and the transcript wrapper is
  fixed, a hostile or malformed guidance string can degrade quality but cannot
  change the output contract slot or unwrap the transcript.

## Part 3 — Export layer

### Exporter interface (destination-agnostic)

```ts
// apps/extension/utils/actionExport.ts
export interface ActionExportResult {
  ok: boolean;
  results: { id: string; ok: boolean; error?: string }[];
  pageUrl?: string;         // destination deep link when available
}
// v1 has a single implementation: exportViaNativeHost(sessionId, items)
```

The side-panel UI depends only on this shape. Later destinations (Obsidian
checklist append, MCP-client) are new implementations plus a destination
picker; no UI or summary changes.

### Native messaging protocol

New message pair in `packages/shared/src/types.ts` /
`apps/native-host/src/protocol.ts`, alongside the sync messages:

```ts
{ type: 'export_actions', protocolVersion: 1, sessionId: string,
  items: ActionItem[] }
→ { ok: boolean, error?: string,
    results: { id: string; ok: boolean; error?: string }[],
    pageUrl?: string }
```

Sent over a short-lived `connectNative` port (same pattern as
`nativeSync.ts`, with an ack timeout). The host handler:

1. Loads config; if Notion is not enabled/configured, replies
   `ok: false, error: 'Notion is not configured'` (sanitized, token-scrubbed).
2. Resolves the session's Notion page from `notionPages.json`. If absent or
   `partial`, creates the page first via the existing `createNotionPage`
   (using the meeting already synced to `~/ScribeTab/meetings/`; if the
   meeting has not been synced, reply with an error telling the user to sync
   first — the extension retries sync automatically, so this is rare).
3. Filters out items already marked exported (idempotency map below).
4. Appends blocks (mapping below) under an `Action items` heading_2, batched
   by the existing `batchBlocks`, using the existing `notionFetch`
   (429 retry, deadline budget).
5. Records per-item outcomes and replies.

### Notion block mapping

- Extend the `NotionBlock` union in `notion.ts` with `to_do` and
  `bulleted_list_item`.
- Each action item → one `to_do` block, `checked: false`, single rich-text
  line composed host-side: `owner — text (due)` with owner/due omitted when
  absent; chunked via `chunkRichText` if ever >2000 chars.
- A `heading_2` "Action items" block is appended once per page (its presence
  is tracked in the idempotency map, not re-queried from Notion).
- Decisions/narrative/useful info are NOT part of action export; they reach
  Notion through the existing page body via `summaryMarkdown`.

### Idempotency

New host-side map `notionActions.json` (same location/permissions pattern as
`notionPages.json`, atomic writes, 0600):

```ts
Record<sessionId, {
  pageId: string;
  headingAdded: boolean;
  items: Record<itemId, { ok: true; at: string }>;
}>
```

- An item present with `ok: true` is never re-sent; the host reports it back
  as `ok: true` (idempotent success), and the UI shows it as exported.
- Batches are all-or-nothing per Notion request: items in a batch are marked
  exported only after that batch's 2xx. A failure mid-way leaves earlier
  batches marked, later ones unmarked — retry sends only the unmarked ones.
- Regenerating the summary creates new item ids; old export records for the
  session remain but are inert. The UI warns before regenerating a summary
  that has exported items ("export history won't carry over").

### Side-panel UI

In the session detail view (`apps/extension/entrypoints/sidepanel/main.tsx`):

- Structured rendering when `summary` exists: narrative prose, "Decisions"
  bullets, "Useful info" bullets (sections hidden when empty). Fallback to
  the current pre-wrap `summaryMarkdown` article otherwise; `degraded: true`
  shows the plain-summary notice.
- "Action items" section: one checkbox per item, **checked by default**;
  already-exported items render with an "exported" badge and a disabled,
  unchecked checkbox. Force-resending an already-exported item (e.g. after
  deleting the to-do in Notion) is explicitly out of scope for v1 —
  idempotency wins.
- Button: `Export N to Notion` (count = selected). Disabled while busy or
  when N = 0. On response: successes get the badge; failures show their
  per-item error inline and the button becomes `Retry M failed`.
- Export state for badges comes from the host's reply and is cached on the
  stored session (`actionExports?: Record<itemId, { destination: 'notion';
  at: string }>`) so badges survive panel reloads without querying the host.
- Error surface reuses the existing `actionError` row for transport-level
  failures (host missing, timeout), with the existing host-missing copy.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| LLM returns non-JSON | Raw text becomes narrative, `degraded` notice, no crash |
| LLM call fails | Existing `intelligence: 'pending'` retry path, unchanged |
| Host not installed / disabled | Transport error via existing host-status copy; no export |
| Meeting not yet synced to host | Host replies with a "sync first" error; extension's existing auto-resync covers it |
| Notion unconfigured / bad token / 404 parent | Sanitized error from existing `notionError` mapping shown in panel |
| Partial batch failure | Landed batches marked exported; retry sends only the rest |
| Duplicate export click | Idempotency map filters; reply reports items as ok |

## Testing

TDD throughout; all pure logic lands in `packages/shared` or host modules
with existing test harnesses.

- shared: prompt assembly (fixed frame + guidance injection), JSON parsing
  (fences, prose-wrapped JSON, missing fields, garbage → fallback),
  `summaryToMarkdown`, id assignment.
- host: `export_actions` handler with mocked fetch — page resolution, heading
  once, batching boundaries, per-batch marking, idempotent re-send, error
  sanitization (token never in replies), map file round-trip.
- extension (vitest, chrome mocks): settings normalization for
  `summaryPrompt`, intelligence storing `summary` + derived markdown,
  export flow state machine (select → export → badges/retry).
- Manual Chrome checklist (owner) before each merge, per workflow.

## Phases

1. **Structured summary** — schema, single-call prompt + parser, fallback,
   `summaryToMarkdown`, intelligence wiring, sectioned side-panel rendering
   (checkboxes render-only, no export button yet).
2. **Editable prompt** — setting, options textarea + reset, assembly wiring.
3. **Notion action export** — protocol message, host handler + block mapping
   + `notionActions.json`, exporter interface, checkbox/export/retry UI.

Later (out of scope here): destination picker + Obsidian checklist exporter;
MCP-client exporter; OpenRouter/Anthropic chat adapters.

Each phase: own branch, TDD, owner's manual Chrome checklist, then merge.
No pushes to remotes unasked.
