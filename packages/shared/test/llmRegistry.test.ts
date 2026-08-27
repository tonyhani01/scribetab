import { describe, expect, it } from 'vitest';
import { LLM_PROVIDER_IDS, getLlmProvider, llmEndpoint } from '../src/llm';

describe('LLM provider registry', () => {
  it('exposes openai and custom ids', () => {
    expect([...LLM_PROVIDER_IDS].sort()).toEqual(['custom', 'openai']);
  });

  it('returns the matching provider', () => {
    expect(getLlmProvider('openai').id).toBe('openai');
    expect(getLlmProvider('custom').id).toBe('custom');
  });

  it('throws on unknown id', () => {
    expect(() => getLlmProvider('nope')).toThrow(/Unknown LLM provider: nope/);
  });
});

describe('llmEndpoint', () => {
  it('returns the openai default base url', () => {
    expect(llmEndpoint('openai')).toBe('https://api.openai.com/v1');
  });

  it('prefers an explicit baseUrl', () => {
    expect(llmEndpoint('openai', 'http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });

  it('throws for custom without baseUrl', () => {
    expect(() => llmEndpoint('custom')).toThrow(/custom: baseUrl is required/);
  });
});
