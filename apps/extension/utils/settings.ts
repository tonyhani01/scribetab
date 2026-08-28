import type { LlmProviderId, RetentionDays, TranscriptionProviderId } from '@scribetab/shared';
import { isLlmProviderId, isRetentionDays, isTranscriptionProviderId } from '@scribetab/shared';

export interface Settings {
  providerId: '' | TranscriptionProviderId;
  apiKey: string;      // current STT provider — chrome.storage.local ONLY
  model: string;       // '' = provider default
  apiKeys: Record<string, string>;  // STT keys keyed by provider id
  models: Record<string, string>;   // STT models keyed by provider id
  language: string;    // '' = provider auto-detect; BCP-47 hint otherwise
  baseUrl: string;     // custom provider only
  micEnabled: boolean;
  retainAudio: boolean; // when false, audioChunks are deleted on session finalize
  nativeHostEnabled: boolean; // sync finalized sessions to com.scribetab.host
  llmProviderId: '' | LlmProviderId;
  llmApiKey: string;
  llmModel: string;
  llmApiKeys: Record<string, string>;
  llmModels: Record<string, string>;
  llmBaseUrl: string;  // custom LLM only (Ollama / LM Studio)
  redactAtRest: boolean;
  redactTerms: string[];
  captionsOnly: boolean; // Meet captions → TranscriptSegment, zero STT provider calls
  consentReminder: boolean; // banner when a recording starts; default on
  summaryPrompt: string; // '' = use default guidance
  /** Audio retention: auto-delete chunks this many days after the meeting ends. */
  retentionDays: RetentionDays;
}

export const DEFAULT_SETTINGS: Settings = {
  providerId: '',
  apiKey: '',
  model: '',
  apiKeys: {},
  models: {},
  language: '',
  baseUrl: '',
  micEnabled: false,
  retainAudio: true,
  nativeHostEnabled: true,
  llmProviderId: '',
  llmApiKey: '',
  llmModel: '',
  llmApiKeys: {},
  llmModels: {},
  llmBaseUrl: '',
  redactAtRest: false,
  redactTerms: [],
  captionsOnly: false,
  consentReminder: true,
  summaryPrompt: '',
  retentionDays: 'forever',
};

const KEY = 'settings';

function asStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function asProviderId(v: unknown): '' | TranscriptionProviderId {
  return typeof v === 'string' && isTranscriptionProviderId(v) ? v : '';
}

function asLlmProviderId(v: unknown): '' | LlmProviderId {
  return typeof v === 'string' && isLlmProviderId(v) ? v : '';
}

/** Merge stored settings, migrate single-key fields into per-provider maps. */
export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const src = raw ?? {};
  const apiKeys = asStringMap(src.apiKeys);
  const models = asStringMap(src.models);
  const llmApiKeys = asStringMap(src.llmApiKeys);
  const llmModels = asStringMap(src.llmModels);
  const providerId = asProviderId(src.providerId);
  const llmProviderId = asLlmProviderId(src.llmProviderId);

  if (providerId && typeof src.apiKey === 'string' && src.apiKey && apiKeys[providerId] === undefined) {
    apiKeys[providerId] = src.apiKey;
  }
  if (providerId && typeof src.model === 'string' && src.model && models[providerId] === undefined) {
    models[providerId] = src.model;
  }
  if (llmProviderId && typeof src.llmApiKey === 'string' && src.llmApiKey && llmApiKeys[llmProviderId] === undefined) {
    llmApiKeys[llmProviderId] = src.llmApiKey;
  }
  if (llmProviderId && typeof src.llmModel === 'string' && src.llmModel && llmModels[llmProviderId] === undefined) {
    llmModels[llmProviderId] = src.llmModel;
  }

  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...src,
    providerId,
    llmProviderId,
    apiKeys,
    models,
    llmApiKeys,
    llmModels,
    apiKey: providerId ? (apiKeys[providerId] ?? '') : '',
    model: providerId ? (models[providerId] ?? '') : '',
    llmApiKey: llmProviderId ? (llmApiKeys[llmProviderId] ?? '') : '',
    llmModel: llmProviderId ? (llmModels[llmProviderId] ?? '') : '',
  };
  if (!Array.isArray(merged.redactTerms)) merged.redactTerms = [];
  if (typeof merged.summaryPrompt !== 'string') merged.summaryPrompt = '';
  if (!isRetentionDays(merged.retentionDays)) merged.retentionDays = 'forever';
  return merged;
}

function persistCurrent(s: Settings): Settings {
  const apiKeys = { ...s.apiKeys };
  const models = { ...s.models };
  const llmApiKeys = { ...s.llmApiKeys };
  const llmModels = { ...s.llmModels };
  if (s.providerId) {
    apiKeys[s.providerId] = s.apiKey;
    models[s.providerId] = s.model;
  }
  if (s.llmProviderId) {
    llmApiKeys[s.llmProviderId] = s.llmApiKey;
    llmModels[s.llmProviderId] = s.llmModel;
  }
  return { ...s, apiKeys, models, llmApiKeys, llmModels };
}

export function withSttProvider(s: Settings, id: '' | TranscriptionProviderId): Settings {
  const persisted = persistCurrent(s);
  return {
    ...persisted,
    providerId: id,
    apiKey: id ? (persisted.apiKeys[id] ?? '') : '',
    model: id ? (persisted.models[id] ?? '') : '',
  };
}

export function withLlmProvider(s: Settings, id: '' | LlmProviderId): Settings {
  const persisted = persistCurrent(s);
  return {
    ...persisted,
    llmProviderId: id,
    llmApiKey: id ? (persisted.llmApiKeys[id] ?? '') : '',
    llmModel: id ? (persisted.llmModels[id] ?? '') : '',
  };
}

export function withSttField(s: Settings, field: 'apiKey' | 'model', value: string): Settings {
  const persisted = persistCurrent({ ...s, [field]: value });
  return persisted;
}

export function withLlmField(s: Settings, field: 'llmApiKey' | 'llmModel', value: string): Settings {
  const persisted = persistCurrent({ ...s, [field]: value });
  return persisted;
}

export async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.local.get(KEY);
  return normalizeSettings(v[KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: persistCurrent(s) });
}
