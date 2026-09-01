# Store release automation — 2026-09-01

Goal: one-command local release prep + store preflight checks, feeding the existing tag-triggered `.github/workflows/release.yml`.

## Context
- v1.1.0 submitted to CWS 2026-08-28 (manual). release.yml handles tag → typecheck/test/build/zip → (gated) `wxt submit` → GH release.
- Missing: version bump tooling, CHANGELOG, store preflight (asset dims, manifest sanity, zip hygiene).
- Store submit stays gated on `CHROME_PUBLISH_ENABLED` + CHROME_* secrets (user configures via `wxt submit init`).

## Tasks
- **R1 — `scripts/release.mjs`** (pi glm-5.3-flash): `node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]`. Preflight (clean tree, main branch, versions in sync) → bump root + `apps/extension/package.json` → prepend CHANGELOG.md section from commit subjects since last `v*` tag → run `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @scribetab/extension zip`, then release-checks → commit `chore(release): vX.Y.Z` + annotated tag. **Never pushes**; prints push instructions. Pure helpers (bump math, changelog text) exported + `node:test` tests.
- **R2 — `scripts/release-checks.mjs`** (pi glm-5.3-flash): exports `runChecks({rootDir, expectedVersion})` → `{ok, failures}` + CLI. Checks: store asset PNG dimensions via IHDR parse (icon 128×128, screenshots 1280×800, promo 440×280 & 1400×560); built manifest (version match, description ≤132 chars, no localhost in permissions/host_permissions/content_scripts); zip present for version, no `.map`/dotfiles inside (`unzip -l`). `node:test` tests with generated PNG fixtures.
- **R3 — wiring + docs** (pi glm-5.3-flash): add `node scripts/release-checks.mjs` step to release.yml before store submit; root `"release"` script; `docs/RELEASING.md` (flow, secrets setup via `wxt submit init`, store ID `empcoocfpoihhdjnpnocdgffgdgaknoe` vs dev ID note).

## Pipeline
pi agents in parallel worktrees (disjoint files) → Fable reviews diffs + runs tests → sequential merge into `feat/release-automation` → user verifies (dry-run a release) → user decides merge. No pushes without ask.
