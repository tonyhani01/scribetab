import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  formatUsd,
  llmCostUsd,
  pcmWavDurationMs,
  sttCostUsd,
} from '../src/costs';

describe('sttCostUsd', () => {
  it('bills OpenAI Whisper at $0.006 per minute', () => {
    expect(sttCostUsd('openai', 60_000)).toBe(0.006);
    expect(sttCostUsd('openai', 30_000)).toBe(0.003);
  });

  it('is zero for custom/local and unknown providers', () => {
    expect(sttCostUsd('custom', 120_000)).toBe(0);
    expect(sttCostUsd('nope', 120_000)).toBe(0);
  });

  it('is zero for non-positive duration', () => {
    expect(sttCostUsd('openai', 0)).toBe(0);
    expect(sttCostUsd('openai', -1)).toBe(0);
  });
});

describe('llmCostUsd', () => {
  it('uses gpt-4o-mini-class rates for openai', () => {
    // 1M prompt tokens → $0.15; 1M completion → $0.60
    expect(llmCostUsd('openai', 1_000_000, 0)).toBe(0.15);
    expect(llmCostUsd('openai', 0, 1_000_000)).toBe(0.6);
    expect(llmCostUsd('openai', 2_000, 500)).toBe(0.0006);
  });

  it('is zero for custom/local', () => {
    expect(llmCostUsd('custom', 10_000, 10_000)).toBe(0);
  });
});

describe('estimateTokens', () => {
  it('uses ~4 chars per token and never returns 0 for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});

describe('formatUsd', () => {
  it('shows extra precision under a cent', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.006)).toBe('$0.0060');
    expect(formatUsd(1.2)).toBe('$1.20');
  });
});

describe('pcmWavDurationMs', () => {
  it('computes duration from 16-bit mono PCM plus 44-byte header', () => {
    const sampleRate = 16_000;
    const samples = 16_000; // 1s
    expect(pcmWavDurationMs(44 + samples * 2, sampleRate)).toBe(1000);
  });

  it('is zero for a header-only or invalid buffer', () => {
    expect(pcmWavDurationMs(44, 16_000)).toBe(0);
    expect(pcmWavDurationMs(100, 0)).toBe(0);
  });
});
