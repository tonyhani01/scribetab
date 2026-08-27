export interface Settings {
  providerId: '' | 'openai' | 'groq' | 'deepgram' | 'mistral' | 'custom';
  apiKey: string;      // chrome.storage.local ONLY — never sync, never any server
  model: string;       // '' = provider default
  language: string;    // '' = provider auto-detect; BCP-47 hint otherwise
  baseUrl: string;     // custom provider only
  micEnabled: boolean;
  retainAudio: boolean; // when false, audioChunks are deleted on session finalize
}

export const DEFAULT_SETTINGS: Settings = {
  providerId: '',
  apiKey: '',
  model: '',
  language: '',
  baseUrl: '',
  micEnabled: false,
  retainAudio: true,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((v[KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}
