import type { LlmProviderId } from '@scribetab/shared';

export interface Settings {
  providerId: '' | 'openai' | 'groq' | 'deepgram' | 'mistral' | 'custom';
  apiKey: string;      // chrome.storage.local ONLY — never sync, never any server
  model: string;       // '' = provider default
  language: string;    // '' = provider auto-detect; BCP-47 hint otherwise
  baseUrl: string;     // custom provider only
  micEnabled: boolean;
  retainAudio: boolean; // when false, audioChunks are deleted on session finalize
  nativeHostEnabled: boolean; // sync finalized sessions to com.scribetab.host
  llmProviderId: '' | LlmProviderId;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;  // custom LLM only (Ollama / LM Studio)
  redactAtRest: boolean;
  redactTerms: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  providerId: '',
  apiKey: '',
  model: '',
  language: '',
  baseUrl: '',
  micEnabled: false,
  retainAudio: true,
  nativeHostEnabled: true,
  llmProviderId: '',
  llmApiKey: '',
  llmModel: '',
  llmBaseUrl: '',
  redactAtRest: false,
  redactTerms: [],
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.local.get(KEY);
  const merged = { ...DEFAULT_SETTINGS, ...((v[KEY] as Partial<Settings> | undefined) ?? {}) };
  if (!Array.isArray(merged.redactTerms)) merged.redactTerms = [];
  return merged;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}
