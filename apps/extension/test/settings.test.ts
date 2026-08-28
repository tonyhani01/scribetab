import { describe, expect, it } from 'vitest';
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
