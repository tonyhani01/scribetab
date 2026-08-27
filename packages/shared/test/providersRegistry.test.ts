import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPTION_PROVIDER_IDS,
  getTranscriptionProvider,
  transcriptionEndpoint,
} from '../src/providers';

describe('provider registry', () => {
  it('exposes the five v1 provider ids', () => {
    expect([...TRANSCRIPTION_PROVIDER_IDS].sort()).toEqual(
      ['custom', 'deepgram', 'groq', 'mistral', 'openai'],
    );
  });

  it('returns the matching provider', () => {
    expect(getTranscriptionProvider('groq').id).toBe('groq');
  });

  it('throws on unknown id', () => {
    expect(() => getTranscriptionProvider('nope')).toThrow(/Unknown transcription provider: nope/);
  });
});

describe('transcriptionEndpoint', () => {
  it('returns the provider default base url', () => {
    expect(transcriptionEndpoint('openai')).toBe('https://api.openai.com/v1');
    expect(transcriptionEndpoint('deepgram')).toBe('https://api.deepgram.com');
  });

  it('prefers an explicit baseUrl', () => {
    expect(transcriptionEndpoint('openai', 'http://localhost:9000/v1')).toBe('http://localhost:9000/v1');
  });

  it('throws for custom without baseUrl', () => {
    expect(() => transcriptionEndpoint('custom')).toThrow(/custom: baseUrl is required/);
  });
});
