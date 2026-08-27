import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  LLM_PROVIDER_IDS,
  TRANSCRIPTION_PROVIDER_IDS,
  isLlmProviderId,
  llmEndpoint,
  originPattern,
  transcriptionEndpoint,
} from '@scribetab/shared';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '@/utils/settings';

const MODEL_PLACEHOLDERS: Record<string, string> = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
  deepgram: 'nova-2',
  mistral: 'voxtral-mini-latest',
  custom: 'whisper-1',
};

const LLM_MODEL_PLACEHOLDERS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  custom: 'llama3.2',
};

function App() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    void getSettings().then(setS);
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setStatus(null);
    try {
      if (s.providerId === 'custom' && !s.baseUrl.trim()) {
        throw new Error('Custom STT provider needs a base URL (e.g. http://localhost:8080/v1)');
      }
      if (s.llmProviderId === 'custom' && !s.llmBaseUrl.trim()) {
        throw new Error('Custom LLM needs a base URL (e.g. http://localhost:11434/v1)');
      }
      const origins: string[] = [];
      if (s.providerId !== '') {
        origins.push(originPattern(transcriptionEndpoint(s.providerId, s.baseUrl.trim() || undefined)));
      }
      if (s.llmProviderId !== '') {
        origins.push(originPattern(llmEndpoint(s.llmProviderId, s.llmBaseUrl.trim() || undefined)));
      }
      const uniqueOrigins = [...new Set(origins)];
      if (uniqueOrigins.length > 0) {
        const granted = await chrome.permissions.request({ origins: uniqueOrigins });
        if (!granted) {
          throw new Error(
            `Permission for ${uniqueOrigins.join(', ')} was declined — the provider cannot be reached`,
          );
        }
      }
      await saveSettings({
        ...s,
        baseUrl: s.baseUrl.trim(),
        llmBaseUrl: s.llmBaseUrl.trim(),
        redactTerms: s.redactTerms.map((t) => t.trim()).filter(Boolean),
      });
      setStatus({
        kind: 'ok',
        text: uniqueOrigins.length
          ? `Saved. Access granted for ${uniqueOrigins.join(', ')}`
          : 'Saved. Transcription and summaries are off (no providers chosen).',
      });
    } catch (e) {
      setStatus({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const row = { display: 'block', margin: '12px 0 4px', fontWeight: 600 } as const;
  const input = { width: '100%', maxWidth: 420, padding: 6 } as const;

  return (
    <main style={{ maxWidth: 560, margin: '24px auto', padding: 16, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>ScribeTab settings</h1>
      <p style={{ color: '#555', fontSize: 13 }}>
        Bring your own key. Keys are stored only in this browser profile
        (<code>chrome.storage.local</code>) and are sent only to the endpoint you configure.
      </p>

      <label style={row} for="provider">Transcription provider</label>
      <select
        id="provider"
        style={input}
        value={s.providerId}
        onChange={(e) => set('providerId', (e.currentTarget as HTMLSelectElement).value as Settings['providerId'])}
      >
        <option value="">Off (record only)</option>
        {TRANSCRIPTION_PROVIDER_IDS.map((id) => (
          <option value={id}>{id === 'custom' ? 'custom (OpenAI-compatible / local server)' : id}</option>
        ))}
      </select>

      {s.providerId !== '' && (
        <>
          {s.providerId === 'custom' && (
            <>
              <label style={row} for="baseUrl">Base URL</label>
              <input
                id="baseUrl"
                style={input}
                placeholder="http://localhost:8080/v1"
                value={s.baseUrl}
                onInput={(e) => set('baseUrl', (e.currentTarget as HTMLInputElement).value)}
              />
            </>
          )}

          <label style={row} for="apiKey">API key {s.providerId === 'custom' && '(optional for local servers)'}</label>
          <input
            id="apiKey"
            type="password"
            autocomplete="off"
            style={input}
            value={s.apiKey}
            onInput={(e) => set('apiKey', (e.currentTarget as HTMLInputElement).value)}
          />

          <label style={row} for="model">Model (blank = default)</label>
          <input
            id="model"
            style={input}
            placeholder={MODEL_PLACEHOLDERS[s.providerId] ?? ''}
            value={s.model}
            onInput={(e) => set('model', (e.currentTarget as HTMLInputElement).value)}
          />

          <label style={row} for="language">Language hint (blank = auto, e.g. "en", "sv")</label>
          <input
            id="language"
            style={input}
            value={s.language}
            onInput={(e) => set('language', (e.currentTarget as HTMLInputElement).value)}
          />
        </>
      )}

      <label style={{ ...row, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.micEnabled}
          onChange={(e) => set('micEnabled', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Mix in my microphone (echo-cancelled; falls back to tab-only if denied)
      </label>

      <label style={{ ...row, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.nativeHostEnabled}
          onChange={(e) => set('nativeHostEnabled', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Sync finalized meetings to the native host (<code>com.scribetab.host</code>)
      </label>

      <label style={{ ...row, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.retainAudio}
          onChange={(e) => set('retainAudio', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Keep audio after a meeting ends (off = delete WAV chunks on finalize; transcript stays)
      </label>

      <label style={{ ...row, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.captionsOnly}
          onChange={(e) => set('captionsOnly', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Captions-only (Google Meet): build the transcript from live captions — no transcription API calls
      </label>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Summaries (LLM)</h2>
      <p style={{ color: '#555', fontSize: 13 }}>
        On finalize, a configured chat model writes a summary and action-item checklist.
        Ollama / LM Studio work via the custom OpenAI-compatible base URL.
      </p>

      <label style={row} for="llmProvider">LLM provider</label>
      <select
        id="llmProvider"
        style={input}
        value={s.llmProviderId}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          set('llmProviderId', isLlmProviderId(v) ? v : '');
        }}
      >
        <option value="">Off (no summary)</option>
        {LLM_PROVIDER_IDS.map((id) => (
          <option value={id}>{id === 'custom' ? 'custom (OpenAI-compatible / Ollama / LM Studio)' : id}</option>
        ))}
      </select>

      {s.llmProviderId !== '' && (
        <>
          {s.llmProviderId === 'custom' && (
            <>
              <label style={row} for="llmBaseUrl">LLM base URL</label>
              <input
                id="llmBaseUrl"
                style={input}
                placeholder="http://localhost:11434/v1"
                value={s.llmBaseUrl}
                onInput={(e) => set('llmBaseUrl', (e.currentTarget as HTMLInputElement).value)}
              />
            </>
          )}

          <label style={row} for="llmApiKey">
            LLM API key {s.llmProviderId === 'custom' && '(optional for local servers)'}
          </label>
          <input
            id="llmApiKey"
            type="password"
            autocomplete="off"
            style={input}
            value={s.llmApiKey}
            onInput={(e) => set('llmApiKey', (e.currentTarget as HTMLInputElement).value)}
          />

          <label style={row} for="llmModel">LLM model (blank = default)</label>
          <input
            id="llmModel"
            style={input}
            placeholder={LLM_MODEL_PLACEHOLDERS[s.llmProviderId] ?? ''}
            value={s.llmModel}
            onInput={(e) => set('llmModel', (e.currentTarget as HTMLInputElement).value)}
          />
        </>
      )}

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Redaction</h2>
      <p style={{ color: '#555', fontSize: 13 }}>
        Text-only. Emails, phone numbers, Luhn-checked cards, SSNs, and custom terms
        are stripped before LLM calls, and before storage when enabled below.
        Raw audio sent to STT cannot be pre-redacted; retained WAV files are unredacted.
      </p>
      <label style={{ ...row, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.redactAtRest}
          onChange={(e) => set('redactAtRest', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Redact PII at rest (stored segments and live transcript)
      </label>
      <label style={row} for="redactTerms">Custom terms (one per line)</label>
      <textarea
        id="redactTerms"
        style={{ ...input, minHeight: 80, fontFamily: 'inherit' }}
        value={s.redactTerms.join('\n')}
        onInput={(e) =>
          set(
            'redactTerms',
            (e.currentTarget as HTMLTextAreaElement).value.split(/\r?\n/),
          )
        }
      />

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Integrations</h2>
      <p style={{ color: '#555', fontSize: 13 }}>
        Obsidian vault copy and Notion page creation run in the native host (off by default).
        Configure with <code>scribetab-host config set</code> — the Notion token is stored only in
        the host config file and is sent only to <code>api.notion.com</code>.
      </p>
      <pre style={{ fontSize: 12, background: '#f6f6f6', padding: 8, overflow: 'auto' }}>{`scribetab-host config set obsidianEnabled true
scribetab-host config set obsidianVaultPath /path/to/vault
scribetab-host config set notionEnabled true
scribetab-host config set notion.token secret
scribetab-host config set notion.parentPageId PAGE_ID`}</pre>
      <p style={{ color: '#555', fontSize: 13 }}>
        Config file:
        macOS <code>~/Library/Application Support/ScribeTab/config.json</code>;
        Linux <code>~/.local/share/ScribeTab/config.json</code>;
        Windows <code>%APPDATA%\ScribeTab\config.json</code>.
        NotebookLM has no public API — use <strong>Export for NotebookLM</strong> in the Library.
      </p>

      <div style={{ marginTop: 16 }}>
        <button onClick={() => void save()}>Save</button>
      </div>
      {status && (
        <p style={{ color: status.kind === 'ok' ? 'green' : 'crimson', fontSize: 13 }}>{status.text}</p>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
