/** Map unknown failures to a short human sentence. Never return stacks. */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/No active tab/i, 'No active tab to record.'],
  [/Already recording/i, 'Already recording this tab.'],
  [/Operation in progress/i, 'Please wait — a start/stop is already in progress.'],
  [/Offscreen failed/i, 'Could not start the recorder. Try again.'],
  [/Stop failed/i, 'Could not stop the recorder cleanly.'],
  [/Nothing recorded/i, 'Nothing recorded yet.'],
  [/Busy recording/i, 'Finish the current recording before syncing.'],
  [/Nothing to sync/i, 'No completed meetings to sync.'],
  [/No LLM configured/i, 'Configure an LLM provider in settings to generate summaries.'],
  [/needs-permission/i, 'The LLM host permission is missing. Grant it and try again.'],
  [/cannot be captured|not capturable|This page cannot be recorded/i, 'This page cannot be recorded.'],
  [/tabCapture|getMediaStreamId/i, 'This page cannot be recorded.'],
  [/Extension context invalidated/i, 'ScribeTab reloaded. Close this view and open it again.'],
  [/Failed to fetch|NetworkError|Load failed|network error/i, 'Network error — check the URL, your connection, and host permission.'],
  [
    /Specified native messaging host|host not installed|not found|native messaging host/i,
    'Native host is not installed. Run node apps/native-host/dist/host.bin.js install (or npx scribetab-host install once published).',
  ],
  [
    /forbidden/i,
    'Native host access is forbidden. Re-run node apps/native-host/dist/host.bin.js install with this extension ID.',
  ],
  [/Permission .+ declined|was declined/i, 'Permission was declined, so that provider cannot be reached.'],
  [/base URL/i, 'Enter a valid http(s) base URL for the custom provider.'],
  [/apiKey is required|API key/i, 'This provider needs an API key.'],
  [/HTTP 401|HTTP 403/i, 'The API key was rejected.'],
  [/HTTP 404/i, 'The provider URL looks wrong (404).'],
];

export const GENERIC_USER_ERROR = 'Something went wrong. Try again, or check settings.';

const HUMANIZED = new Set<string>([GENERIC_USER_ERROR, ...RULES.map(([, msg]) => msg)]);

export function humanError(err: unknown): string {
  const raw = normalizeError(err);
  if (!raw) return GENERIC_USER_ERROR;
  if (HUMANIZED.has(raw)) return raw;
  for (const [re, msg] of RULES) {
    if (re.test(raw)) return msg;
  }
  return GENERIC_USER_ERROR;
}

export function normalizeError(err: unknown): string {
  if (err == null) return '';
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0]!.replace(/^Error:\s*/i, '').trim();
}
