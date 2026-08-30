# Competitive analysis — ScribeTab vs Otter.ai, Read.ai, Tactiq

**Date:** 2026-08-30
**Scope:** Feature gaps, highest-leverage additions, and quality-of-life ideas worth copying. Sources: official feature/pricing/help pages, Chrome Web Store listings + reviews, Trustpilot/G2, 2026 written reviews (tl;dv, Business Dive, MeetGeek, Bluedot, anarlog, HappyScribe), and YouTube review metadata (transcripts were not fetchable; sentiment comes from titles/descriptions plus the reviewers' companion articles).
**ScribeTab baseline:** v1.1.0 as in `README.md`, `apps/extension/utils/settings.ts`, side panel/library views, native host + MCP.

---

## 1. Where ScribeTab already wins

These are the things competitors are *losing users over*, and ScribeTab gets them for free by design. Lead with them in the listing and README.

| Competitor pain (from reviews) | ScribeTab today |
| --- | --- |
| Otter: class action over recording without consent; auto-shares transcripts with attendees; "why does tab capture need my mic?" | In-Meet consent banner, no sharing at all, mic is opt-in |
| Read.ai: "spreads like a virus" onboarding, universities banning it, 1.4★ Trustpilot | No account, no backend, no bot |
| Tactiq: "no audio, so transcript errors are uncorrectable"; lost transcripts unrecoverable; must *pay* to stop auto-transcription | Audio retained (Opus), explicit start only |
| Otter: 6 languages, manual selection; Tactiq: one language per session, garbles switching | Provider-agnostic; Scribe v2 / Gemini auto-detect; Arabic research already done |
| All three: cloud-only, US storage, per-seat $8–30/mo, credit caps (Tactiq Free = 5 AI credits) | Local + BYOK, cost meter, local whisper/Ollama |
| Otter/Read: MCP only recently, Tactiq MCP read = Team+ | Local MCP server since v1 |

---

## 2. What they offer that ScribeTab doesn't

Grouped by area. ✅ = all three have it, ◐ = some.

### Capture
- ✅ **Calendar awareness** — upcoming meetings list, auto-title from event, "Remind me / Record automatically" per platform (Otter Desktop Aug 2026), pre-meeting notifications.
- ✅ **Import audio/video/transcript files** (Tactiq: up to 2 GB; Otter/Read minutes-capped).
- ◐ **Desktop capture of non-browser apps** (Zoom/Teams desktop, Slack Huddles, in-person) — Otter Desktop, Read Operator, Tactiq Mac beta. ScribeTab is tab-only.
- ◐ **Caption-based speakers on Zoom web / Teams web** (Tactiq). ScribeTab's caption fusion is Meet-only.
- ◐ **Slide/screen capture inline in transcript** (Otter auto slide capture; Tactiq screenshot button).
- ◐ Pause/resume mid-recording (Otter, Tactiq).

### Live UX
- ✅ **Live "catch me up" / ask-AI-so-far** during the meeting (Otter Chat, Read Catch Me Up, Tactiq Ask AI with preset chips).
- ✅ **In-meeting overlay** (Otter floating overlay, Tactiq widget) — not just a side panel.
- ◐ Typed tags on moments (Tactiq: action item / decision / question / custom emoji tags; keyword auto-highlight). ScribeTab has one untyped highlight.
- ◐ Private notes typed during the call, merged into transcript (Tactiq, Read).
- ◐ Meet chat messages saved with transcript (Tactiq).
- ◐ Live rolling summary (Otter, Read).

### Post-meeting intelligence
- ✅ **Chat with a transcript / across all transcripts** with citations (Otter AI Chat, Read Ask Read, Tactiq AI Agent). Biggest single gap.
- ✅ **Summary templates / prompt library** (Otter templates, Read Templates + push template, Tactiq Kits with ~dozens of prompts, BANT/SPIN etc.). ScribeTab has one editable guidance string.
- ✅ **Chapters/outline with timestamps** in the summary.
- ◐ Multi-meeting / daily digest (Tactiq Daily Digest, Otter cross-meeting chat, Read pre-reads of the previous recurring instance).
- ◐ Speaker talk-time stats (all three); coaching/sentiment (Read — widely criticised, skip).
- ◐ Personal AI context (role, team, expertise, output language) fed into prompts (Tactiq).
- ◐ Custom vocabulary / dictionary auto-correct (Otter, Read, Tactiq).
- ◐ Draft follow-up email / generate tasks / generate slides from a transcript (Tactiq, Read).

### Library & organisation
- ✅ **Audio playback synced to transcript, click-to-seek, word highlight, 0.5–3× + skip silence** (Otter). ScribeTab stores audio but the library can't play it.
- ✅ **Transcript editing** (fix words, split/merge paragraphs, Otter has undo/redo + keyboard shortcuts).
- ✅ Folders / labels / auto-labels (Tactiq auto-label by title, participant, duration; Read auto topic folders).
- ✅ Advanced search filters (speaker, date, platform, label).
- ◐ Speaker merge; cross-meeting speaker memory (Otter voiceprints).
- ◐ Archive with 30-day recovery; bulk export.

### Integrations & sharing
- ✅ Google Docs/Drive auto-save, Slack push, CRM (HubSpot/Salesforce), Zapier/webhooks, task tools (Asana/Jira/Linear).
- ✅ Share links, comments, team spaces. (Deliberately out of scope for a no-backend product — don't chase.)
- ◐ **Automation/workflow builder** (Tactiq: trigger on title/participant → AI prompt → Notion/Slack/Linear, with review gate).
- ◐ Export: DOCX/PDF (Otter, Tactiq), MP3 (Otter), PPTX (Tactiq). ScribeTab: MD/JSON/SRT/VTT/NotebookLM + WAV.

---

## 3. Highest-leverage features to add (ranked)

Ranking weighs: user value, how often reviewers ask for it, fit with the no-backend/BYOK architecture, and effort given existing code.

### Tier 1 — do these next

1. **Audio playback in the library, synced to segments.**
   Audio is already stored (Opus/WAV chunks in IndexedDB, `chunkStore.ts`). Add a player in `LibraryView`: click a segment → seek; current segment highlighted while playing; 1×/1.5×/2×; keyboard: Esc play/pause, ←/→ ±5 s (Otter's exact bindings). This is the feature Tactiq is most criticised for lacking and it makes every other correction feature possible. Effort: small–medium, zero new permissions.

2. **Chat with transcript (and with the whole library).**
   Reuse the existing LLM provider + `DATA_FRAMING` from `summarize.ts`. Side panel "Ask" tab: preset chips (*Catch me up*, *What was decided?*, *Open questions*, *Draft follow-up email*) + free text; works live (over segments so far) and post-meeting. Cross-library mode: MiniSearch retrieves top-N segments → same chat call with citations `[session / mm:ss]`. Ollama makes it fully local — a story none of the three can tell. Effort: medium.

3. **Prompt library / summary templates.**
   Turn `summaryPrompt` into a list of named templates (Standup, 1:1, Sales discovery, Lecture/YouTube, Interview, Custom…) selectable per session before/after recording, plus "Regenerate with template X". Add a small **personal context** block (name, role, team, output language) injected into every prompt (Tactiq's most-praised QoL). Effort: small; mostly options UI + prompt assembly.

4. **Transcript editing + typed tags.**
   Inline edit of segment text (already have `RENAME_SPEAKER`/mutation queue plumbing — add `EDIT_SEGMENT`), split/merge, and turn highlights into typed markers: 🔴 decision, ✅ action, ❓ question, ⭐ highlight, each with its own hotkey and a filter in the library. Edited text should flow into re-summarise and exports. Effort: medium.

5. **Import files** (audio/video/VTT/SRT/TXT).
   Drop a file in the library → chunk with the existing `SilenceChunker` → same STT path; VTT/SRT/TXT skip STT. Opens ScribeTab to recordings from Zoom desktop, phone memos, lectures. Effort: small–medium (`downloads`/file picker only, no new permission).

### Tier 2 — strong value, more work

6. **Calendar awareness without an account.** Read the user's Google Calendar via an optional per-origin grant to `www.googleapis.com` with the user's own OAuth client / or simpler: a content script on `calendar.google.com` is invasive — prefer the native host reading an `.ics` URL the user pastes (private iCal link) and exposing "next meeting" → auto-title sessions, "REC?" badge pre-armed with the event name, reminder notification 2 min before. Keep it host-side and off by default.

7. **Zoom web + Teams web caption fusion.** Generalise `meet-captions.content.ts` (selectors in `meetSelectors.ts`) into a per-platform adapter; Teams needs the user's "identify me in captions" setting (document it like Tactiq does). Delivers speaker names on the two other platforms the listing already claims to support.

8. **Local automations (Tactiq-workflows-lite).** In the native host: rules "when a session finalises and title contains X / speaker includes Y → run template Z → write to Obsidian folder / Notion page / append to a daily note". Config in the host JSON, optional "review before sending" flag. Pairs with the existing Obsidian/Notion writers; no new network surface.

9. **Chapters + talk-time in the structured summary.** Extend `SessionSummary` with `chapters: {title, startMs}[]`; compute per-speaker talk time locally from segments (no LLM). Both render at the top of `SummaryView` and export to MD.

10. **Custom vocabulary.** Pass as `prompt` (OpenAI/Groq whisper), `keyterms` (Deepgram), or post-STT find/replace dictionary for providers without support. Reviewers of all three cite name/jargon errors as the #1 accuracy complaint.

### Tier 3 — nice, later

11. Streaming STT for near-instant text (Deepgram live / Scribe realtime) — the spec already rejected this once for scope; revisit after playback + chat.
12. Multi-meeting digest ("summarise this week") — falls out of #2's cross-library retrieval.
13. DOCX/PDF export and MP3 export; bulk export zip.
14. In-page floating overlay for the live transcript (Otter's extension pattern) for users who don't keep the side panel open.
15. Cross-meeting speaker memory (map "Speaker 2" → name once per recurring meeting title).
16. Desktop/system-audio capture via the native host (Otter Desktop / Read Operator territory) — big; only if tab-only proves too limiting.

**Explicitly not worth copying:** meeting bots, engagement/sentiment/charisma scoring (Read's most-hated feature and an EU AI Act risk), forced auto-sharing to attendees, team spaces/accounts, credit systems.

---

## 4. Quality-of-life improvements to copy

Cheap, mostly UI-level:

- **Keyboard shortcuts in the library** (Otter): `⌘K` search focus, `Esc` play/pause, `←/→` seek, `Enter` split paragraph, `Backspace` merge, `⌘Z/⌘Y`, `⌘/` shows the cheat-sheet.
- **Preset AI chips** instead of an empty prompt box (Tactiq): *Summarise so far · Key points · 3 follow-up questions · What did we decide?*
- **Auto-title from page/tab or calendar** and auto-labels by rule (title contains, duration, speaker count) with system labels `1:1`, `Long meeting`, `YouTube` (Tactiq).
- **Copy transcript with/without timestamps/speakers; "combine same-speaker paragraphs"** as export options (Otter export dialog).
- **Post-meeting notification** ("Transcript ready · Summary ready") via `chrome.notifications` (needs one permission) — all three email you; ScribeTab is silent after stop.
- **Archive (soft delete, 30 days) before hard delete** (Tactiq) — the library has a `Delete` button only.
- **Pause/resume** in the popup and hotkey.
- **Private notes field** during recording, merged into the transcript at the timestamp typed.
- **Save Meet chat messages** alongside the transcript (Tactiq toggle) — the content script already sits in Meet.
- **Theme toggle** light/dark/system (Tactiq); ScribeTab uses theme tokens already.
- **Companion-mode note** in docs: captions-only mode works when you're in the room on a second laptop (Tactiq documents this; ScribeTab can too).
- **First-run test recording** (Tactiq's troubleshooting advice, made into onboarding): "Record 30 s of this YouTube tab to verify your provider" using the existing `providerProbe`.
- **Per-session cost + provider/model shown in the library card** (ScribeTab's cost meter is a differentiator — surface it more).
- **Speaker merge** next to speaker rename.

---

## 5. Suggested sequencing

| Phase | Items | Why first |
| --- | --- | --- |
| A | #1 playback, QoL shortcuts, archive, notification | Unlocks corrections; small; no new permissions except `notifications` |
| B | #2 chat (live + library), #3 templates + personal context | Turns transcripts into the "knowledge engine" all three now market — locally |
| C | #4 editing + typed tags, #5 import, #10 vocabulary | Accuracy and coverage complaints |
| D | #6 calendar (host-side), #7 Zoom/Teams captions, #8 local automations, #9 chapters/talk-time | Platform parity and automation |

---

## Appendix — competitor snapshots (Aug 2026)

- **Otter.ai** — "Conversational Knowledge Engine"; bot + bot-free Desktop with Automatic Recording; Chrome ext records any tab (300k users, 4.1★); 6 transcription languages, manual; AI Chat w/ MCP connectors (Notion, Jira, Salesforce, Drive), Otter MCP server on all tiers; Free 300 min/mo, Pro $8.33–16.99, Business $19.99–30; video replay Enterprise-only; consent class action; complaints: speaker ID, forced sharing, mic permission, login loops.
- **Read.ai** — bot + botless Google Meet (Meet Media API, Mar 2026) + desktop Operator + mobile; engagement/sentiment/coaching scores; Ask Read across meetings/email/Slack/Drive w/ Actions; Ada email assistant; 27 languages auto-detect; MCP/REST/Claude connector; Free 5 reports/mo, Pro $15, Enterprise $22.50, E+ $29.75; playback Enterprise-only; Trustpilot 1.4★ over viral auto-join.
- **Tactiq** — pure caption-scraping Chrome ext (1M users, 4.8★), no audio stored; widget with tags/screenshots/notes/agenda/Ask AI; Kits + AI Workflows builder with Notion/Slack/HubSpot/Linear; Spaces, labels, auto-labels; MCP (search Free, read Team+); Free 10 meetings/5 AI credits, Pro $8, Team $16.67, Business $29.17; complaints: accuracy/language switching, no audio, lost transcripts, credits, pay-to-stop-auto-transcribe, billing.

Full per-competitor notes with URLs are in the research transcripts that produced this file; the key sources are otter.ai/pricing, help.otter.ai, read.ai/plans-pricing, support.read.ai, tactiq.io/buy, help.tactiq.io, the three Chrome Web Store listings, tldv.io and thebusinessdive.com 2026 reviews.
