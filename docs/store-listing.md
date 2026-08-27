# Chrome Web Store listing (draft)

Version: 1.0.0. Do not treat this file as legal advice.

## Short description (132 chars max — draft)

BYOK meeting transcriber. Capture tab audio locally, transcribe with your key or a local model — no bot, no ScribeTab servers.

## Full description (draft)

ScribeTab records the active browser tab (Google Meet, Teams web, Zoom web, YouTube, or any http(s) page) without a meeting bot and without a screen-share picker.

You bring your own transcription and (optional) LLM provider. API keys stay in this browser profile. Audio and transcripts are not sent to ScribeTab — there are no ScribeTab servers. Cloud STT/LLM calls go only to the origin you configure and grant. A localhost OpenAI-compatible server (whisper.cpp, Speaches, LM Studio, Ollama) never leaves the machine.

Optional native host (`node apps/native-host/dist/host.bin.js install`; `npx scribetab-host install` once published) writes meetings to `~/ScribeTab/meetings/` and can copy Markdown into Obsidian or create a Notion page. MCP tools let an agent read those files.

Hotkeys (rebind at chrome://extensions/shortcuts): Alt+Shift+R start, Alt+Shift+S stop, Alt+Shift+T side panel. A `REC?` badge appears on known meeting tabs.

Source: GPL-3.0-only.

## Privacy disclosures

- **No ScribeTab backend.** The extension does not phone home.
- **Audio** is captured in an offscreen document, stored in IndexedDB on this profile, and sent only to the user-configured STT endpoint when transcription is enabled.
- **API keys** live in `chrome.storage.local` and are sent only as `Authorization` or `x-goog-api-key` headers to that endpoint (or the LLM endpoint). Never as a query parameter.
- **Transcripts and summaries** stay in IndexedDB unless the user exports them, syncs to the optional native host, or enables Notion (token stored only in the host config file, sent only to `api.notion.com`).
- **Redaction** is text-only. Raw audio sent to STT cannot be pre-redacted.
- **Consent.** A reminder banner (default on) asks the user to get participant consent before recording. Recording other people without consent may be illegal in your jurisdiction.

## Permission justifications

| Permission | Why |
| --- | --- |
| `tabCapture` | Capture the active tab’s audio via `getMediaStreamId`. |
| `offscreen` | Run the Web Audio graph and worklet outside the service worker. |
| `storage` | Settings, capture state, and IndexedDB-adjacent flags. |
| `downloads` | User-initiated WAV and transcript exports. |
| `activeTab` | Act on the tab the user invoked the extension on. |
| `sidePanel` | Live transcript + library UI. |
| `nativeMessaging` | Optional sync to `com.scribetab.host`. Unused if the host is not installed. |
| `tabs` | Observe tab URLs (and titles) for badge detection: `REC?` on Meet/Teams/Zoom, `REC` on the captured tab, and to hide capture on `chrome://` pages. Least privilege vs site host permissions (those would allow injecting into meeting sites). The Meet content script already matches `https://meet.google.com/*` only. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | Granted per origin from options (Save / Test connection) for the STT or LLM endpoint the user typed — cloud or localhost. Never granted for all sites up front. |

Commands (`chrome.commands`) need no extra permission.

## Single-purpose

Tab-audio capture and local/BYOK transcription of meetings.

## Data usage (store form)

- User data is not sold.
- User data is not used for purposes unrelated to the single purpose.
- Personally identifiable information is not sold.
- Remote code is not used.

## Support / homepage

Fill in when creating the listing. Source and issues live in this repository.
