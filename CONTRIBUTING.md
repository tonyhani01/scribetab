# Contributing to ScribeTab

## Setup

- Node ≥ 20, pnpm 9 (`packageManager` in the root `package.json`)
- `pnpm install` at the repo root
- `pnpm -r test`, `pnpm -r typecheck`, `pnpm build`

## Layout

pnpm workspaces: `apps/*` and `packages/*`. Locked session/transcript types live
in `packages/shared/src/types.ts` — do not change them without updating
`docs/superpowers/plans/2026-08-26-scribetab-roadmap.md`.

## Tests (TDD)

Pure modules (providers, export, fusion, redaction, URL/platform helpers) are
written test-first with Vitest. UI and Chrome plumbing get focused unit tests
where logic can be extracted; Playwright covers the extension shell.

```
pnpm --filter @scribetab/shared test
pnpm --filter @scribetab/extension test
pnpm --filter scribetab-host test
pnpm --filter @scribetab/extension e2e
```

e2e loads the built MV3 bundle in Chromium (`--load-extension`), stays offline,
and does not call real STT/LLM providers. Install the browser once:

`pnpm --filter @scribetab/extension exec playwright install chromium`

## Branch flow

1. Branch from `main` (`phase-N-…` or a short feature name)
2. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`)
3. Keep the worktree green (`pnpm -r test` and `pnpm -r typecheck`)
4. Open a PR into `main`. Do not push tags or merge from feature worktrees
   unless the maintainer asks.

Phase write-ups go in `docs/superpowers/plans/`.

## Extension notes

- No new runtime dependencies without an explicit decision
- Host permission for STT/LLM origins is requested from the options page
- Keys stay in `chrome.storage.local`
