# ScribeTab Privacy Policy

_Last updated: 2026-08-28_

ScribeTab is a bring-your-own-key (BYOK) meeting transcription extension. It has
**no backend**: there are no ScribeTab servers, no analytics, and no telemetry.
The extension never phones home.

## What data ScribeTab handles

- **Tab audio.** When you start a recording, the active tab's audio is captured
  in an offscreen document and stored in IndexedDB in your browser profile. If
  you enable transcription, audio is sent **only** to the speech-to-text
  endpoint you configured (a cloud provider you hold the key for, or a local
  server such as whisper.cpp that never leaves your machine).
- **Transcripts and summaries.** Stored in IndexedDB in your browser profile.
  They leave your machine only if you export them, sync them to the optional
  local native host, or enable the optional Notion integration.
- **API keys.** Stored in `chrome.storage.local` on your device. They are sent
  only as `Authorization` or `x-goog-api-key` headers to the endpoint you
  configured — never as URL parameters, and never to ScribeTab.
- **Tab URLs and titles.** Read locally to show a recording badge on known
  meeting tabs and to disable capture on `chrome://` pages. This information is
  not stored beyond the session and is never transmitted.

## What ScribeTab does not do

- No data is sold or shared with third parties.
- No data is sent anywhere except the STT/LLM endpoints **you** configure and
  explicitly grant via Chrome's per-origin permission prompt.
- No remote code is loaded or executed.
- No ads, no tracking, no analytics.

## Optional integrations (off by default)

- **Native host.** If installed, finished meetings are written as files to
  `~/ScribeTab/meetings/` on your computer, and can optionally be copied into an
  Obsidian vault.
- **Notion.** If enabled, meeting pages are created via `api.notion.com` using
  a token you provide, stored only in the host's local config file.

## Consent and redaction

A reminder banner (on by default) asks you to obtain participant consent before
recording. Recording people without consent may be illegal in your
jurisdiction — that responsibility is yours. Text redaction of PII applies to
transcripts only; raw audio sent to your STT endpoint cannot be pre-redacted.

## Data removal

All extension data lives in your browser profile. Remove it via the extension's
wipe function or by uninstalling the extension. Files written by the native
host live in `~/ScribeTab/` and are yours to delete.

## Contact

Questions or concerns: open an issue on this repository or email
tonyhani01@gmail.com.
