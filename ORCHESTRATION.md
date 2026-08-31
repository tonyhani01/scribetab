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
| B2 chat | shared builder committed; wiring pending | |
| B3 library ask | pending | |
| C1 edit segments | done | pass | |
| C2 typed tags | pending | |
| C3 import | done | pass | |
| C4 vocabulary | done | pass (260 ext, 335 shared, typecheck) | |
| D1 chapters+talktime | done | pass (309 shared tests) | |
| D2 zoom/teams captions | done | pass (7 selector tests, ext build ok) | |
| D3 ics calendar | done | pass (147 host, 7 ext) | |
| D4 automations | done | pass (106 host tests) | |
| E1 export options | done | pass (5+346 tests) | |
| E2 labels | pending | |
| E3 notes | pending | |
| E4 meet chat | done | pass (305 ext tests, typecheck) | |
| E5 theme | done | pass (21 tests) | |
| E6 cost card+onboarding | done | pass | |
| E7 speaker merge | done | pass (8 tests) | |
| F1 docs | pending | |
