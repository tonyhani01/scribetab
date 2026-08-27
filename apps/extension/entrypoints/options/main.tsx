import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  TRANSCRIPTION_PROVIDER_IDS,
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
      if (s.providerId === '') {
        // No provider = record-only mode; still a valid save.
        await saveSettings(s);
        setStatus({ kind: 'ok', text: 'Saved. Transcription is off (no provider chosen).' });
        return;
      }
      if (s.providerId === 'custom' && !s.baseUrl.trim()) {
        throw new Error('Custom provider needs a base URL (e.g. http://localhost:8080/v1)');
      }
      const endpoint = transcriptionEndpoint(s.providerId, s.baseUrl.trim() || undefined);
      const origin = originPattern(endpoint);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`Permission for ${origin} was declined — transcription cannot reach the endpoint`);
      await saveSettings({ ...s, baseUrl: s.baseUrl.trim() });
      setStatus({ kind: 'ok', text: `Saved. Access granted for ${origin}` });
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
          checked={s.retainAudio}
          onChange={(e) => set('retainAudio', (e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Keep audio after a meeting ends (off = delete WAV chunks on finalize; transcript stays)
      </label>

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
