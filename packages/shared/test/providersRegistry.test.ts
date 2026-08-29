import { describe, expect, it } from 'vitest';
import {
  GOOGLE_API_BASE,
  TRANSCRIPTION_PROVIDER_IDS,
  getTranscriptionProvider,
  isTranscriptionProviderId,
  transcriptionEndpoint,
} from '../src/providers';

describe('provider registry', () => {
  it('exposes the registered provider ids', () => {
    expect([...TRANSCRIPTION_PROVIDER_IDS].sort()).toEqual(
      ['custom', 'deepgram', 'elevenlabs', 'google', 'groq', 'mistral', 'openai', 'openrouter'],
    );
  });

  it('returns the matching provider', () => {
    expect(getTranscriptionProvider('groq').id).toBe('groq');
  });

  it('throws on unknown id', () => {
    expect(() => getTranscriptionProvider('nope')).toThrow(/Unknown transcription provider: nope/);
  });

  it('guards provider ids from the registry list', () => {
    expect(isTranscriptionProviderId('openrouter')).toBe(true);
    expect(isTranscriptionProviderId('google')).toBe(true);
    expect(isTranscriptionProviderId('elevenlabs')).toBe(true);
    expect(getTranscriptionProvider('elevenlabs').id).toBe('elevenlabs');
    expect(isTranscriptionProviderId('')).toBe(false);
    expect(isTranscriptionProviderId('nope')).toBe(false);
  });

  it('freezes the exported provider-id array', () => {
    expect(Object.isFrozen(TRANSCRIPTION_PROVIDER_IDS)).toBe(true);
    expect(() => {
      (TRANSCRIPTION_PROVIDER_IDS as unknown as string[]).push('evil');
    }).toThrow();
    expect(isTranscriptionProviderId('evil')).toBe(false);
  });
});

describe('transcriptionEndpoint', () => {
  it('returns the provider default base url', () => {
    expect(transcriptionEndpoint('openai')).toBe('https://api.openai.com/v1');
    expect(transcriptionEndpoint('deepgram')).toBe('https://api.deepgram.com');
    expect(transcriptionEndpoint('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(transcriptionEndpoint('google')).toBe(GOOGLE_API_BASE);
    expect(GOOGLE_API_BASE).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(transcriptionEndpoint('elevenlabs')).toBe('https://api.elevenlabs.io/v1');
  });

  it('ignores a stale baseUrl for cloud providers so keys cannot leak', () => {
    expect(transcriptionEndpoint('openai', 'http://localhost:9000/v1')).toBe(
      'https://api.openai.com/v1',
    );
    expect(transcriptionEndpoint('openrouter', 'http://evil.example/v1')).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(transcriptionEndpoint('google', 'http://evil.example/v1')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(transcriptionEndpoint('elevenlabs', 'http://evil.example/v1')).toBe(
      'https://api.elevenlabs.io/v1',
    );
  });

  it('uses an explicit baseUrl only for custom', () => {
    expect(transcriptionEndpoint('custom', 'http://localhost:9000/v1')).toBe(
      'http://localhost:9000/v1',
    );
  });

  it('throws for custom without baseUrl', () => {
    expect(() => transcriptionEndpoint('custom')).toThrow(/custom: baseUrl is required/);
  });
});
