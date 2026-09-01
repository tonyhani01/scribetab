# Orchestration ledger — feature/competitive-qol
Plan: docs/superpowers/plans/2026-08-31-competitive-qol.md
Implementers: pi @ openrouter/qwen/qwen3.8-flash · Review: codex gpt-5.6-sol + Fable
Costs/speed: /tmp/st-orch/costs.tsv

| Task | Status | Verdict |
|---|---|---|
| A1 playback | done | pass (249 ext tests, typecheck) | |
| A4 pause/resume | done | pass (7 tests, typecheck) | |
| A2 archive | done | pass | |
| A3 notifications | done | pass (305 ext tests, typecheck) | |
| B1 templates+context | done | pass (44 tests, typecheck) | |
| B2 chat | done | pass (313 ext tests, typecheck) |
| B3 library ask | done | pass (330 ext tests, typecheck) — pi glm-5.3-flash $0.054 |
| C1 edit segments | done | pass | |
| C2 typed tags | done | pass (331 ext, 364 shared, typecheck) — pi glm $0.051 |
| C3 import | done | pass | |
| C4 vocabulary | done | pass (260 ext, 335 shared, typecheck) | |
| D1 chapters+talktime | done | pass (309 shared tests) | |
| D2 zoom/teams captions | done | pass (7 selector tests, ext build ok) | |
| D3 ics calendar | done | pass (147 host, 7 ext) | |
| D4 automations | done | pass (106 host tests) | |
| E1 export options | done | pass (5+346 tests) | |
| E2 labels | done | pass (339 ext tests, typecheck) — pi glm $0.029 |
| E3 notes | done | pass (332 ext, 365 shared, typecheck) — pi glm $0.030 |
| E4 meet chat | done | pass (305 ext tests, typecheck) | |
| E5 theme | done | pass (21 tests) | |
| E6 cost card+onboarding | done | pass | |
| E7 speaker merge | done | pass (8 tests) | |
| F1 docs | done | README + store-listing + PRIVACY updated (orchestrator) |

# Orchestration ledger — feat/release-automation (2026-09-01)
Plan: docs/superpowers/plans/2026-09-01-store-release-automation.md
Implementers: pi @ openrouter/z-ai/glm-5.3-flash · Review: Fable (orchestrator)

| Task | Status | Verdict |
|---|---|---|
| R1 release.mjs | done | pass (9/9 node:test, dry-run ok, code reviewed) |
| R2 release-checks.mjs | done | pass (10/10 node:test, CLI verified, code reviewed) |
| R3 CI wiring + RELEASING.md | done | pass (yaml+json parse ok, diff reviewed) |
