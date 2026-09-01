import type {
  LlmProviderId,
  PersonalContext,
  RetentionDays,
  SummaryTemplate,
  TranscriptionProviderId,
} from '@scribetab/shared';
import {
  EMPTY_PERSONAL_CONTEXT,
  allSummaryTemplates,
  findBuiltinTemplate,
  isBuiltinTemplateId,
  isLlmProviderId,
  isRetentionDays,
  isTranscriptionProviderId,
  personalContextLine,
  resolveSummaryGuidance,
} from '@scribetab/shared';

/** Color scheme preference. `system` follows the OS `prefers-color-scheme`. */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export interface Settings {
  providerId: '' | TranscriptionProviderId;
  apiKey: string;      // current STT provider — chrome.storage.local ONLY
  model: string;       // '' = provider default
  apiKeys: Record<string, string>;  // STT keys keyed by provider id
  models: Record<string, string>;   // STT models keyed by provider id
  language: string;    // '' = provider auto-detect; BCP-47 hint otherwise
  /** Speaker diarization (ElevenLabs Scribe toggle); default on. */
  diarize: boolean;
  /** Gemini Smart mode: clean formatted text, no timestamps/diarization. */
  googleSmartMode: boolean;
  vocabTerms: string[]; // recognition hints and wrong=>right correction rules
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
  saveMeetChat: boolean; // append observed Google Meet chat lines to the caption pipeline
  consentReminder: boolean; // banner when a recording starts; default on
  notifyOnReady: boolean; // desktop notification after transcript/summary completion
  /**
   * Legacy single guidance string, superseded by `summaryTemplates`.
   * Kept so an older stored blob can be migrated (see `normalizeSettings`);
   * it is always `''` on a normalized Settings object and is never read for prompting.
   */
  summaryPrompt: string;
  /** User guidance templates (forked builtins and "Custom" migrations). */
  summaryTemplates: SummaryTemplate[];
  /** `''` = ScribeTab default guidance; otherwise an id in `summaryTemplates` or `BUILTIN_TEMPLATES`. */
  activeTemplateId: string;
  /** Who the summary is written for; rendered as one fixed system-prompt line. */
  personalContext: PersonalContext;
  /** Audio retention: auto-delete chunks this many days after the meeting ends. */
  retentionDays: RetentionDays;
  /** UI color scheme; mirrored onto `<html data-theme>` by utils/theme.ts. */
  theme: ThemeChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  providerId: '',
  apiKey: '',
  model: '',
  apiKeys: {},
  models: {},
  language: '',
  diarize: true,
  googleSmartMode: false,
  vocabTerms: [],
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
  saveMeetChat: false,
  consentReminder: true,
  notifyOnReady: true,
  summaryPrompt: '',
  summaryTemplates: [],
  activeTemplateId: '',
  personalContext: { ...EMPTY_PERSONAL_CONTEXT },
  retentionDays: 'forever',
  theme: 'system',
};

/** Storage key holding the whole Settings blob in chrome.storage.local. */
export const SETTINGS_STORAGE_KEY = 'settings';

/** Id given to a template migrated out of the legacy `summaryPrompt` string. */
export const LEGACY_CUSTOM_TEMPLATE_ID = 'legacy-custom';

/** Name shown for that migrated template. */
export const LEGACY_CUSTOM_TEMPLATE_NAME = 'Custom';

/** Upper bound on user templates, so a corrupted blob cannot bloat storage. */
export const MAX_SUMMARY_TEMPLATES = 50;

/** Upper bound on each personal-context field (chars). */
export const PERSONAL_CONTEXT_FIELD_LIMIT = 200;

/** Label for the `''` (no template) choice in any picker. */
export const DEFAULT_TEMPLATE_LABEL = 'Default (ScribeTab guidance)';

function asStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function asTheme(v: unknown): ThemeChoice {
  return typeof v === 'string' && (THEME_CHOICES as readonly string[]).includes(v)
    ? (v as ThemeChoice)
    : 'system';
}

function asProviderId(v: unknown): '' | TranscriptionProviderId {
  return typeof v === 'string' && isTranscriptionProviderId(v) ? v : '';
}

function asLlmProviderId(v: unknown): '' | LlmProviderId {
  return typeof v === 'string' && isLlmProviderId(v) ? v : '';
}

/** One-line, length-capped text for a personal-context field; anything odd becomes ''. */
function asContextField(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, PERSONAL_CONTEXT_FIELD_LIMIT);
}

/** Corrupted storage must not be able to inject prompt lines, hence the collapsing above. */
function asPersonalContext(v: unknown): PersonalContext {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...EMPTY_PERSONAL_CONTEXT };
  const rec = v as Record<string, unknown>;
  return {
    name: asContextField(rec.name),
    role: asContextField(rec.role),
    team: asContextField(rec.team),
    outputLanguage: asContextField(rec.outputLanguage),
  };
}

/** Keep only whole, string-shaped templates; built-in ids are reserved. */
function asSummaryTemplates(v: unknown): SummaryTemplate[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: SummaryTemplate[] = [];
  for (const raw of v) {
    if (out.length >= MAX_SUMMARY_TEMPLATES) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.id !== 'string') continue;
    const id = rec.id.trim();
    if (!id || isBuiltinTemplateId(id) || seen.has(id)) continue;
    if (typeof rec.name !== 'string' || typeof rec.guidance !== 'string') continue;
    seen.add(id);
    out.push({ id, name: rec.name.trim(), guidance: rec.guidance });
  }
  return out;
}

/** A stored id that resolves to a real template, or '' (default guidance). */
function asTemplateId(v: unknown, templates: readonly SummaryTemplate[]): string {
  if (typeof v !== 'string') return '';
  const id = v.trim();
  if (!id) return '';
  return allSummaryTemplates(templates).some((t) => t.id === id) ? id : '';
}

/** Guidance currently in force (`undefined` falls back to `activeTemplateId`; `''` means default). */
export function summaryGuidance(s: Settings, templateId?: string): string {
  const id = templateId === undefined ? s.activeTemplateId : templateId;
  return resolveSummaryGuidance(allSummaryTemplates(s.summaryTemplates), id);
}

/** Template currently in force (`undefined` uses the active id), or undefined for default guidance. */
export function findSummaryTemplate(s: Settings, templateId?: string): SummaryTemplate | undefined {
  const id = templateId === undefined ? s.activeTemplateId : templateId;
  if (!id) return undefined;
  return allSummaryTemplates(s.summaryTemplates).find((t) => t.id === id);
}

/** Built-in templates plus the user's own, in dropdown order. */
export function summaryTemplateChoices(s: Settings): SummaryTemplate[] {
  return allSummaryTemplates(s.summaryTemplates);
}

/** The one system-prompt line describing the user ('' when nothing is set). */
export function personalContextPromptLine(s: Settings): string {
  return personalContextLine(s.personalContext);
}

/** Fresh id for a forked template. Injectable so tests stay deterministic. */
export function newSummaryTemplateId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `custom-${crypto.randomUUID()}`
    : `custom-${Date.now()}`;
}

/**
 * Edit guidance for one template. Editing a built-in forks it into an
 * independently editable copy which becomes the selected template; editing the
 * `''` default creates a custom template holding just the new text.
 */
export function withSummaryGuidance(
  s: Settings,
  templateId: string,
  guidance: string,
  nextId: () => string = newSummaryTemplateId,
): Settings {
  const builtin = findBuiltinTemplate(templateId);
  if (!templateId || builtin) {
    const id = nextId();
    const fork: SummaryTemplate = {
      id,
      name: (builtin?.name ?? 'My template') + ' (copy)',
      guidance,
    };
    return {
      ...s,
      summaryTemplates: [...s.summaryTemplates, fork],
      activeTemplateId: id,
    };
  }
  return {
    ...s,
    summaryTemplates: s.summaryTemplates.map((t) =>
      t.id === templateId ? { ...t, guidance } : t,
    ),
  };
}

/** Select the template used for future summaries ('' = default guidance). */
export function withActiveTemplateId(s: Settings, templateId: string): Settings {
  return { ...s, activeTemplateId: asTemplateId(templateId, s.summaryTemplates) };
}

/** Keep personal templates intact and select the default ScribeTab guidance. */
export function withDefaultSummaryGuidance(s: Settings): Settings {
  return { ...s, activeTemplateId: '' };
}

export { BUILTIN_TEMPLATES } from '@scribetab/shared';

/** Merge stored settings, migrate single-key fields into per-provider maps. */
export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const src = raw ?? {};
  const apiKeys = asStringMap(src.apiKeys);
  const models = asStringMap(src.models);
  const llmApiKeys = asStringMap(src.llmApiKeys);
  const llmModels = asStringMap(src.llmModels);
  const providerId = asProviderId(src.providerId);
  const llmProviderId = asLlmProviderId(src.llmProviderId);
  const summaryTemplates = asSummaryTemplates(src.summaryTemplates);
  const legacyGuidance = typeof src.summaryPrompt === 'string' ? src.summaryPrompt.trim() : '';

  if (
    legacyGuidance &&
    !summaryTemplates.some((template) => template.id === LEGACY_CUSTOM_TEMPLATE_ID)
  ) {
    if (summaryTemplates.length >= MAX_SUMMARY_TEMPLATES) summaryTemplates.pop();
    summaryTemplates.push({
      id: LEGACY_CUSTOM_TEMPLATE_ID,
      name: LEGACY_CUSTOM_TEMPLATE_NAME,
      guidance: legacyGuidance,
    });
  }
  const requestedTemplateId = asTemplateId(src.activeTemplateId, summaryTemplates);
  const activeTemplateId = requestedTemplateId || (legacyGuidance ? LEGACY_CUSTOM_TEMPLATE_ID : '');

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
    summaryPrompt: '',
    summaryTemplates,
    activeTemplateId,
    personalContext: asPersonalContext(src.personalContext),
    theme: asTheme(src.theme),
    diarize: typeof src.diarize === 'boolean' ? src.diarize : DEFAULT_SETTINGS.diarize,
    googleSmartMode: typeof src.googleSmartMode === 'boolean'
      ? src.googleSmartMode
      : DEFAULT_SETTINGS.googleSmartMode,
    saveMeetChat: typeof src.saveMeetChat === 'boolean'
      ? src.saveMeetChat
      : DEFAULT_SETTINGS.saveMeetChat,
    notifyOnReady: typeof src.notifyOnReady === 'boolean'
      ? src.notifyOnReady
      : DEFAULT_SETTINGS.notifyOnReady,
    apiKey: providerId ? (apiKeys[providerId] ?? '') : '',
    model: providerId ? (models[providerId] ?? '') : '',
    llmApiKey: llmProviderId ? (llmApiKeys[llmProviderId] ?? '') : '',
    llmModel: llmProviderId ? (llmModels[llmProviderId] ?? '') : '',
  };
  if (!Array.isArray(merged.redactTerms)) merged.redactTerms = [];
  merged.vocabTerms = Array.isArray(merged.vocabTerms)
    ? merged.vocabTerms.filter((term): term is string => typeof term === 'string')
    : [];
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
  const v = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(v[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: persistCurrent(s) });
}
