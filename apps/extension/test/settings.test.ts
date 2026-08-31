import { describe, expect, it } from 'vitest';
import { isCuratedSttModel, sttModelCatalog } from '@scribetab/shared';
import { sttProbeRequest } from '../utils/providerProbe';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  withLlmField,
  withLlmProvider,
  withSttField,
  withSttProvider,
  type Settings,
} from '../utils/settings';

describe('normalizeSettings', () => {
  it('defaults custom vocabulary and filters corrupted stored entries', () => {
    expect(DEFAULT_SETTINGS.vocabTerms).toEqual([]);
    expect(normalizeSettings(undefined).vocabTerms).toEqual([]);
    expect(normalizeSettings({
      vocabTerms: ['AcmeCorp', 42, 'teh=>the', null] as unknown as string[],
    }).vocabTerms).toEqual(['AcmeCorp', 'teh=>the']);
    expect(normalizeSettings({ vocabTerms: 'AcmeCorp' as unknown as string[] }).vocabTerms).toEqual([]);
  });

  it('preserves valid retention choices and normalizes invalid stored values', () => {
    expect(normalizeSettings({ retentionDays: 7 }).retentionDays).toBe(7);
    expect(normalizeSettings({ retentionDays: 30 }).retentionDays).toBe(30);
    expect(normalizeSettings({ retentionDays: 'forever' }).retentionDays).toBe('forever');
    expect(normalizeSettings({ retentionDays: 14 as unknown as 7 }).retentionDays).toBe('forever');
    expect(normalizeSettings({ retentionDays: 'bad' as unknown as 'forever' }).retentionDays).toBe('forever');
  });
  it('defaults summaryPrompt to empty and preserves stored values', () => {
    expect(normalizeSettings(undefined).summaryPrompt).toBe('');
    expect(normalizeSettings({ summaryPrompt: 'Budget focus.' } as Partial<Settings>).summaryPrompt).toBe('Budget focus.');
  });
  it('coerces a non-string summaryPrompt to empty', () => {
    expect(normalizeSettings({ summaryPrompt: 42 as unknown as string }).summaryPrompt).toBe('');
  });

  it('migrates a single apiKey/model into the current provider map', () => {
    const s = normalizeSettings({
      providerId: 'openai',
      apiKey: 'sk-openai',
      model: 'whisper-1',
    });
    expect(s.apiKeys.openai).toBe('sk-openai');
    expect(s.models.openai).toBe('whisper-1');
    expect(s.apiKey).toBe('sk-openai');
    expect(s.model).toBe('whisper-1');
  });

  it('does not overwrite an existing per-provider key with the legacy field', () => {
    const s = normalizeSettings({
      providerId: 'openai',
      apiKey: 'stale',
      apiKeys: { openai: 'sk-kept' },
    });
    expect(s.apiKey).toBe('sk-kept');
    expect(s.apiKeys.openai).toBe('sk-kept');
  });
});

describe('per-provider STT credentials', () => {
  it('does not carry the previous provider key or model on switch', () => {
    let s = withSttField(
      withSttField(withSttProvider(DEFAULT_SETTINGS, 'openai'), 'apiKey', 'sk-openai'),
      'model',
      'whisper-1',
    );
    s = withSttProvider(s, 'google');
    expect(s.providerId).toBe('google');
    expect(s.apiKey).toBe('');
    expect(s.model).toBe('');
    expect(s.apiKeys.openai).toBe('sk-openai');
    expect(s.models.openai).toBe('whisper-1');

    const probe = sttProbeRequest(s.providerId, s.apiKey, s.baseUrl);
    expect(probe.headers['x-goog-api-key']).toBeUndefined();
    expect(JSON.stringify(probe.headers)).not.toContain('sk-openai');
  });

  it('probe/save for the new provider uses only that provider key', () => {
    let s = withSttField(withSttProvider(DEFAULT_SETTINGS, 'openai'), 'apiKey', 'sk-openai');
    s = withSttField(withSttProvider(s, 'google'), 'apiKey', 'g-key');
    expect(s.apiKey).toBe('g-key');
    expect(s.apiKeys.openai).toBe('sk-openai');
    expect(s.apiKeys.google).toBe('g-key');

    const googleProbe = sttProbeRequest(s.providerId, s.apiKey, s.baseUrl);
    expect(googleProbe.headers['x-goog-api-key']).toBe('g-key');
    expect(JSON.stringify(googleProbe.headers)).not.toContain('sk-openai');

    s = withSttProvider(s, 'openai');
    const openaiProbe = sttProbeRequest(s.providerId, s.apiKey, s.baseUrl);
    expect(openaiProbe.headers.Authorization).toBe('Bearer sk-openai');
    expect(JSON.stringify(openaiProbe.headers)).not.toContain('g-key');
  });
});

describe('per-provider LLM credentials', () => {
  it('does not carry the previous LLM key or model on switch', () => {
    let s = withLlmField(
      withLlmField(withLlmProvider(DEFAULT_SETTINGS, 'openai'), 'llmApiKey', 'sk-llm'),
      'llmModel',
      'gpt-4o-mini',
    );
    s = withLlmProvider(s, 'custom');
    expect(s.llmApiKey).toBe('');
    expect(s.llmModel).toBe('');
    expect(s.llmApiKeys.openai).toBe('sk-llm');
    expect(s.llmModels.openai).toBe('gpt-4o-mini');
  });
});

describe('provider-specific model choices', () => {
  it("restores each provider's saved model choice when switching back", () => {
    let s = withSttProvider(DEFAULT_SETTINGS, 'openrouter');
    s = withSttField(s, 'model', 'openai/whisper-large-v3-turbo');
    s = withSttProvider(s, 'elevenlabs');
    expect(s.model).toBe('');
    s = withSttField(s, 'model', 'scribe_v2');
    s = withSttProvider(s, 'google');
    s = withSttField(s, 'model', 'gemini-3.5-transcribe');

    s = withSttProvider(s, 'openrouter');
    expect(s.model).toBe('openai/whisper-large-v3-turbo');
    s = withSttProvider(s, 'elevenlabs');
    expect(s.model).toBe('scribe_v2');
    expect(s.models).toEqual({
      openrouter: 'openai/whisper-large-v3-turbo',
      elevenlabs: 'scribe_v2',
      google: 'gemini-3.5-transcribe',
    });
  });

  it('keeps a previously saved free-text model and routes it to the custom path', () => {
    const s = normalizeSettings({ providerId: 'openrouter', models: { openrouter: 'google/chirp-3' } });
    expect(s.model).toBe('google/chirp-3');
    expect(isCuratedSttModel('openrouter', s.model)).toBe(false);
    expect(sttModelCatalog('openrouter').allowCustom).toBe(true);
  });

  it('accepts elevenlabs as a stored provider id', () => {
    const s = normalizeSettings({ providerId: 'elevenlabs', apiKey: 'xi', model: 'scribe_v2' });
    expect(s.providerId).toBe('elevenlabs');
    expect(s.apiKeys.elevenlabs).toBe('xi');
    expect(s.models.elevenlabs).toBe('scribe_v2');
  });
});
