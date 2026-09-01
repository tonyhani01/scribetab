# Changelog

## v1.2.0 — 2026-09-01

- Merge fix/stt-speaker-labels: STT speaker labels + Scribe/Gemini provider options
- fix: surface STT speaker labels; add Scribe diarize toggle and Gemini Smart mode
- chore: gitignore local operator playbook
- docs+release: README status line at v1.1.2, auto-bumped by release script
- chore: widen gitignore to .env.submit* (wizard backups)
- Merge claude/musing-murdock-db2e26: fix flaky native-host protocol test (buffer coalesced acks in test helper)
- ci: dispatchable store-status workflow to query CWS item state
- fix(test): buffer leftover stdout bytes across readNativeMessage calls
- chore: gitignore .env.submit store credentials

## v1.1.2 — 2026-09-01

- Merge feat/mic-permission: options-page mic grant flow — offscreen getUserMedia cannot prompt
- fix(capture): mic permission grant flow in options — offscreen getUserMedia cannot prompt

## v1.1.1 — 2026-09-01

- Merge feat/release-automation: store release tooling — release script, preflight checks, CI wiring, docs
- docs: orchestration ledger for release automation
- Merge pi/release-r1: local release-prep script
- feat(release): local release-prep script with version bump + changelog
- Merge pi/release-r2: store preflight checks
- feat(release): store preflight checks (assets, manifest, zip hygiene)
- Merge pi/release-r3: CI preflight + release script + RELEASING docs
- chore(release): CI preflight step, pnpm release script, RELEASING docs
- docs(plan): store release automation plan
- test(e2e): update popup onboarding assertion to E6 provider-setup card copy
- Merge feature/competitive-qol: playback, chat, templates, editing, tags, import, vocabulary, chapters, calendar, Zoom/Teams captions, automations + QoL
- fix(privacy): redact-at-rest for imported and edited transcript text; no OS notification on manual regenerate
- docs: F1 — README features, notifications permission + caption hosts in store listing, chat\/ics privacy notes
- feat(library): E2 labels — computeLabels at finalize, card chips + filter row
- feat(notes): E3 private notes while recording — note input via ADD_HIGHLIGHT kind:'note', 📝 in flow + exports
- feat(highlights): C2 typed tags — kind on HighlightMoment, ⭐✅🔴❓ buttons, filter chips, emoji exports
- feat(library): B3 ask across the library — selectContext, LIBRARY_ASK, sources UI
- feat(chat): B2 wiring — CHAT_ASK handler, ChatView, Ask tabs in live + library
- feat(qol): A3 ready notifications + E4 Meet chat capture
- feat(library): archive w/ 30-day purge, transcript editing, file import wiring, cost/model cards + popup onboarding
- feat(summary): template picker, options template/context UI, per-run templateId plumbing
- feat(import): shared VTT/SRT/TXT/JSON transcript parser
- feat(capture): pause/resume — PCM gate with chunk flush, ⏸ badge, popup + side-panel controls
- feat(chat): shared transcript chat prompt builder — framing, clipping, citations, history
- feat(summary): builtin summary templates + personal context — shared prompt assembly and settings model
- feat(export): timestamps/speakers/combine toggles + copy-transcript chip
- feat(calendar): host get_upcoming over icsUrl + best-effort session auto-title from calendar
- feat(ui): theme preference — system/light/dark with data-theme tokens and live OS/storage repaint
- feat(library): speaker rename collision becomes a confirmed merge
- feat(host): minimal RFC 5545 ics parser, icsUrl config key, get_upcoming protocol types
- feat(extension): custom vocabulary wiring — settings, options UI, provider hints, post-redaction corrections
- feat(library): audio playback — seek-by-segment, speeds, keyboard, shared assembly with download
- feat(captions): best-effort Zoom web + Teams web caption speaker capture
- feat(stt): custom vocabulary — provider hints (Whisper prompt, Deepgram keyterm) + correction rules
- feat(summary): timestamped chapters in structured summary + per-speaker talk-time bar
- docs: ledger D4 done
- feat(host): rule-based automations routing Obsidian copies to vault subfolders
- docs: competitive QoL implementation plan + orchestration ledger
- fix(extension): probe ElevenLabs via file-less POST /v1/speech-to-text
- test(extension): ElevenLabs probe test for file-less POST; docs: competitive analysis + store assets
- feat(stt): ElevenLabs Scribe v2 provider, curated model choices, settings popup window
