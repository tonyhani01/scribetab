import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  LLM_PROVIDER_IDS,
  TRANSCRIPTION_PROVIDER_IDS,
  isLlmProviderId,
  isTranscriptionProviderId,
  llmEndpoint,
  originPattern,
  transcriptionEndpoint,
} from '@scribetab/shared';
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  withLlmField,
  withLlmProvider,
  withSttField,
  withSttProvider,
  type Settings,
} from '@/utils/settings';
import {
  ensureHostOrigin,
  probeLlm,
  probeTranscription,
  validateHttpUrl,
} from '@/utils/providerProbe';
import { humanError } from '@/utils/userError';
import { listSessions } from '@/utils/sessionStore';
import { monthlySpend, type MonthlySpend } from '@/utils/costMeter';
import { formatUsd } from '@scribetab/shared';
import '@/assets/theme.css';

const MODEL_PLACEHOLDERS: Record<string, string> = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
  deepgram: 'nova-2',
  mistral: 'voxtral-mini-latest',
  openrouter: 'openai/whisper-large-v3',
  google: 'gemini-3.5-transcribe',
  custom: 'whisper-1',
};

const STT_PROVIDER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  google: 'Google Gemini',
  custom: 'custom (OpenAI-compatible / local server)',
};

const LLM_MODEL_PLACEHOLDERS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  custom: 'llama3.2',
};

const row = { display: 'block', margin: '12px 0 4px', fontWeight: 600, fontSize: 12.5, color: 'var(--st-muted)' } as const;
const input = {} as const;
const hint = { color: 'var(--st-muted)', fontSize: 12.5, lineHeight: 1.45 } as const;
const err = { color: 'var(--st-danger)', fontSize: 12, margin: '4px 0 0' } as const;
const section = {} as const;

function App() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sttProbe, setSttProbe] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [llmProbe, setLlmProbe] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [probing, setProbing] = useState<'stt' | 'llm' | null>(null);
  const [spend, setSpend] = useState<MonthlySpend | null>(null);

  useEffect(() => {
    void getSettings().then(setS);
    void listSessions()
      .then((rows) => setSpend(monthlySpend(rows)))
      .catch(() => setSpend(null));
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const sttUrlError = s.providerId === 'custom' ? validateHttpUrl(s.baseUrl) : null;
  const llmUrlError = s.llmProviderId === 'custom' ? validateHttpUrl(s.llmBaseUrl) : null;
  const sttKeyMissing = s.providerId !== '' && s.providerId !== 'custom' && !s.apiKey.trim();
  const llmKeyMissing = s.llmProviderId !== '' && s.llmProviderId !== 'custom' && !s.llmApiKey.trim();
  const sttKeyLabel = s.providerId
    ? `Enter an API key for ${STT_PROVIDER_LABELS[s.providerId] ?? s.providerId}.`
    : 'This provider needs an API key.';
  const llmKeyLabel = s.llmProviderId
    ? `Enter an API key for ${s.llmProviderId}.`
    : 'This provider needs an API key.';
  const languageLabel =
    s.providerId === 'google'
      ? 'Language hint (blank = auto, e.g. en-US, sv-SE, ar-EG)'
      : 'Language hint (blank = auto, e.g. en, ar)';

  const save = async () => {
    setStatus(null);
    try {
      if (sttUrlError) {
        setStatus({ kind: 'err', text: sttUrlError });
        return;
      }
      if (llmUrlError) {
        setStatus({ kind: 'err', text: llmUrlError });
        return;
      }
      if (sttKeyMissing) {
        setStatus({ kind: 'err', text: sttKeyLabel });
        return;
      }
      if (llmKeyMissing) {
        setStatus({ kind: 'err', text: llmKeyLabel });
        return;
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
      setStatus({ kind: 'err', text: humanError(e) });
    }
  };

  const testStt = async () => {
    setSttProbe(null);
    setProbing('stt');
    try {
      const res = await probeTranscription({
        providerId: s.providerId,
        apiKey: s.apiKey,
        baseUrl: s.baseUrl,
        ensureOrigin: ensureHostOrigin,
      });
      setSttProbe({ kind: res.ok ? 'ok' : 'err', text: res.message });
    } catch (e) {
      setSttProbe({ kind: 'err', text: humanError(e) });
    } finally {
      setProbing(null);
    }
  };

  const testLlm = async () => {
    setLlmProbe(null);
    setProbing('llm');
    try {
      const res = await probeLlm({
        providerId: s.llmProviderId,
        apiKey: s.llmApiKey,
        baseUrl: s.llmBaseUrl,
        ensureOrigin: ensureHostOrigin,
      });
      setLlmProbe({ kind: res.ok ? 'ok' : 'err', text: res.message });
    } catch (e) {
      setLlmProbe({ kind: 'err', text: humanError(e) });
    } finally {
      setProbing(null);
    }
  };

  return (
    <main data-testid="options-root" style={{ maxWidth: 600, margin: '24px auto', padding: 16 }}>
      <div class="st-brand" style={{ marginBottom: 4 }}>
        <img src="/icon-48.png" alt="" style={{ width: 34, height: 34 }} />
        <h1 class="st-wordmark" aria-label="ScribeTab settings" style={{ margin: 0, fontSize: 20 }}>
          scribe<b>Tab</b> <span style={{ color: 'var(--st-muted)', fontWeight: 600, fontSize: 16 }}>settings</span>
        </h1>
      </div>
      <p style={hint}>
        Bring your own key. Keys are stored only in this browser profile
        (<code>chrome.storage.local</code>) and are sent only to the endpoint you configure.
      </p>

      <section class="st-section">
        <h2>Capture</h2>
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
            id="retainAudio"
            data-testid="retain-audio"
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
        <label style={{ ...row, fontWeight: 400 }}>
          <input
            id="consentReminder"
            data-testid="consent-reminder"
            type="checkbox"
            checked={s.consentReminder}
            onChange={(e) => set('consentReminder', (e.currentTarget as HTMLInputElement).checked)}
          />{' '}
          Show a consent reminder when recording starts
        </label>
      </section>

      <section class="st-section">
        <h2>Transcription</h2>
        <label style={row} for="provider">Provider</label>
        <select
          id="provider"
          class="st-select"
          value={s.providerId}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            setS((prev) => withSttProvider(prev, isTranscriptionProviderId(v) ? v : ''));
          }}
        >
          <option value="">Off (record only)</option>
          {TRANSCRIPTION_PROVIDER_IDS.map((id) => (
            <option value={id}>{STT_PROVIDER_LABELS[id] ?? id}</option>
          ))}
        </select>

        {s.providerId !== '' && (
          <>
            {s.providerId === 'custom' && (
              <>
                <label style={row} for="baseUrl">Base URL</label>
                <input
                  id="baseUrl"
                  class="st-input"
                  placeholder="http://localhost:8080/v1"
                  value={s.baseUrl}
                  onInput={(e) => set('baseUrl', (e.currentTarget as HTMLInputElement).value)}
                />
                {sttUrlError && <p style={err}>{sttUrlError}</p>}
              </>
            )}

            <label style={row} for="apiKey">API key {s.providerId === 'custom' && '(optional for local servers)'}</label>
            <input
              id="apiKey"
              type="password"
              autocomplete="off"
              class="st-input"
              value={s.apiKey}
              onInput={(e) => setS((prev) => withSttField(prev, 'apiKey', (e.currentTarget as HTMLInputElement).value))}
            />
            {sttKeyMissing && <p style={err}>{sttKeyLabel}</p>}

            <label style={row} for="model">Model (blank = default)</label>
            <input
              id="model"
              class="st-input"
              placeholder={MODEL_PLACEHOLDERS[s.providerId] ?? ''}
              value={s.model}
              onInput={(e) => setS((prev) => withSttField(prev, 'model', (e.currentTarget as HTMLInputElement).value))}
            />

            <label style={row} for="language">{languageLabel}</label>
            <input
              id="language"
              class="st-input"
              placeholder={s.providerId === 'google' ? 'en-US' : 'en'}
              value={s.language}
              onInput={(e) => set('language', (e.currentTarget as HTMLInputElement).value)}
            />

            <div style={{ marginTop: 8 }}>
              <button type="button" class="st-btn st-btn--quiet" disabled={probing !== null} onClick={() => void testStt()}>
                {probing === 'stt' ? 'Testing…' : 'Test STT connection'}
              </button>
              {sttProbe && (
                <p style={{ color: sttProbe.kind === 'ok' ? 'var(--st-success)' : 'var(--st-danger)', fontSize: 13 }}>
                  {sttProbe.text}
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <section class="st-section">
        <h2>Intelligence</h2>
        <p style={hint}>
          On finalize, a configured chat model writes a summary and action-item checklist.
          Ollama / LM Studio work via the custom OpenAI-compatible base URL.
        </p>

        <label style={row} for="llmProvider">LLM provider</label>
        <select
          id="llmProvider"
          class="st-select"
          value={s.llmProviderId}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            setS((prev) => withLlmProvider(prev, isLlmProviderId(v) ? v : ''));
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
                  class="st-input"
                  placeholder="http://localhost:11434/v1"
                  value={s.llmBaseUrl}
                  onInput={(e) => set('llmBaseUrl', (e.currentTarget as HTMLInputElement).value)}
                />
                {llmUrlError && <p style={err}>{llmUrlError}</p>}
              </>
            )}

            <label style={row} for="llmApiKey">
              LLM API key {s.llmProviderId === 'custom' && '(optional for local servers)'}
            </label>
            <input
              id="llmApiKey"
              type="password"
              autocomplete="off"
              class="st-input"
              value={s.llmApiKey}
              onInput={(e) =>
                setS((prev) => withLlmField(prev, 'llmApiKey', (e.currentTarget as HTMLInputElement).value))
              }
            />
            {llmKeyMissing && <p style={err}>{llmKeyLabel}</p>}

            <label style={row} for="llmModel">LLM model (blank = default)</label>
            <input
              id="llmModel"
              class="st-input"
              placeholder={LLM_MODEL_PLACEHOLDERS[s.llmProviderId] ?? ''}
              value={s.llmModel}
              onInput={(e) =>
                setS((prev) => withLlmField(prev, 'llmModel', (e.currentTarget as HTMLInputElement).value))
              }
            />

            <div style={{ marginTop: 8 }}>
              <button type="button" class="st-btn st-btn--quiet" disabled={probing !== null} onClick={() => void testLlm()}>
                {probing === 'llm' ? 'Testing…' : 'Test LLM connection'}
              </button>
              {llmProbe && (
                <p style={{ color: llmProbe.kind === 'ok' ? 'var(--st-success)' : 'var(--st-danger)', fontSize: 13 }}>
                  {llmProbe.text}
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <section class="st-section">
        <h2>Redaction</h2>
        <p style={hint}>
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
          class="st-textarea"
          style={{ minHeight: 80 }}
          value={s.redactTerms.join('\n')}
          onInput={(e) =>
            set(
              'redactTerms',
              (e.currentTarget as HTMLTextAreaElement).value.split(/\r?\n/),
            )
          }
        />
      </section>

      <section class="st-section">
        <h2>Sync / Integrations</h2>
        <label style={{ ...row, fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={s.nativeHostEnabled}
            onChange={(e) => set('nativeHostEnabled', (e.currentTarget as HTMLInputElement).checked)}
          />{' '}
          Sync finalized meetings to the native host (<code>com.scribetab.host</code>)
        </label>
        <p style={hint}>
          Obsidian vault copy and Notion page creation run in the native host (off by default).
          Configure with <code>scribetab-host config set</code> — the Notion token is stored only in
          the host config file and is sent only to <code>api.notion.com</code>.
        </p>
        <pre>{`scribetab-host config set obsidianEnabled true
scribetab-host config set obsidianVaultPath /path/to/vault
scribetab-host config set notionEnabled true
scribetab-host config set notion.token -
scribetab-host config set notion.parentPageId PAGE_ID`}</pre>
        <p style={hint}>
          Config file:
          macOS <code>~/Library/Application Support/ScribeTab/config.json</code>;
          Linux <code>~/.local/share/ScribeTab/config.json</code>;
          Windows <code>%APPDATA%\ScribeTab\config.json</code>.
          NotebookLM has no public API — use <strong>Export for NotebookLM</strong> in the Library.
        </p>
      </section>

      <section class="st-section" data-testid="usage-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2>Usage</h2>
          <span class="st-hint">
            {new Date().toLocaleString(undefined, { month: 'long', year: 'numeric' })}
          </span>
        </div>
        {spend === null || spend.sessionCount === 0 ? (
          <p class="st-hint" style={{ margin: '8px 0 0' }}>
            No sessions yet this month. Costs are estimated from provider list prices as you record.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
              <div class="st-card" style={{ flexGrow: 1, background: 'var(--st-bg)' }}>
                <div class="st-hint">Total spend</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {formatUsd(spend.totalUsd)}
                </div>
              </div>
              <div class="st-card" style={{ flexGrow: 1, background: 'var(--st-bg)' }}>
                <div class="st-hint">Sessions</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {spend.sessionCount}
                </div>
              </div>
              <div class="st-card" style={{ flexGrow: 1, background: 'var(--st-bg)' }}>
                <div class="st-hint">Avg / session</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {spend.knownCount > 0 ? formatUsd(spend.totalUsd / spend.knownCount) : 'n/a'}
                </div>
              </div>
            </div>
            <p class="st-hint" style={{ margin: '10px 0 0' }}>
              Estimated from provider list prices
              {spend.knownCount < spend.sessionCount &&
                ` · ${spend.sessionCount - spend.knownCount} session(s) without a known cost`}
              .
            </p>
          </>
        )}
      </section>

      <div style={{ marginTop: 16 }}>
        <button class="st-btn" data-testid="save-settings" onClick={() => void save()}>Save changes</button>
      </div>
      {status && (
        <p data-testid="save-status" style={{ color: status.kind === 'ok' ? 'var(--st-success)' : 'var(--st-danger)', fontSize: 13 }}>
          {status.text}
        </p>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
