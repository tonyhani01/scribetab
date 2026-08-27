# ScribeTab

Open-source, BYOK-first AI meeting transcriber. Captures audio straight from
browser tabs (Google Meet, Teams web, Zoom web, YouTube) — one click, no
screen-share picker, no bot in your call. Everything stays on your machine;
the only network traffic is the API call to the transcription/LLM endpoint
*you* configure (cloud key or localhost model). Transcripts are exposed to AI
agents and notetaking apps via MCP.

**Status: early development.** Phases 1–8 (scaffold through integrations) are
implemented. Obsidian/Notion: `scribetab-host config set` (see `apps/native-host/README.md`). See `docs/superpowers/specs/` and
`docs/superpowers/plans/` for the design and roadmap. Native host:
`npx scribetab-host install` (dev extension ID `cambjpbepplcihlihagiheggdkfcpmef`).

License: GPL-3.0-only
