import { describe, expect, it } from 'vitest';
import {
  audioTranscribedMs,
  estimateTokens,
  formatUsd,
  llmCostUsd,
  pcmWavDurationMs,
  sttCostUsd,
} from '../src/costs';

describe('sttCostUsd', () => {
  it('bills OpenAI whisper-1 at $0.006 per minute', () => {
    expect(sttCostUsd('openai', 60_000)).toBe(0.006);
    expect(sttCostUsd('openai', 30_000, 'whisper-1')).toBe(0.003);
  });

  it('is zero for custom/local', () => {
    expect(sttCostUsd('custom', 120_000, 'llama')).toBe(0);
  });

  it('is undefined for unknown providers or models (never a wrong guess)', () => {
    expect(sttCostUsd('nope', 120_000)).toBeUndefined();
    expect(sttCostUsd('openai', 60_000, 'gpt-4o-transcribe')).toBeUndefined();
  });

  it('is zero for non-positive duration even with an unknown model', () => {
    expect(sttCostUsd('openai', 0, 'mystery')).toBe(0);
    expect(sttCostUsd('openai', -1)).toBe(0);
  });
});

describe('llmCostUsd', () => {
  it('uses gpt-4o-mini rates for openai default/known model', () => {
    expect(llmCostUsd('openai', 1_000_000, 0)).toBe(0.15);
    expect(llmCostUsd('openai', 0, 1_000_000, 'gpt-4o-mini')).toBe(0.6);
    expect(llmCostUsd('openai', 2_000, 500)).toBe(0.0006);
  });

  it('is zero for custom/local', () => {
    expect(llmCostUsd('custom', 10_000, 10_000)).toBe(0);
  });

  it('is undefined for unknown models', () => {
    expect(llmCostUsd('openai', 1_000, 1_000, 'gpt-4o')).toBeUndefined();
  });
});

describe('audioTranscribedMs', () => {
  it('sums audio segment durations and ignores captions', () => {
    expect(
      audioTranscribedMs([
        { source: 'audio', startMs: 0, endMs: 1_000 },
        { source: 'captions', startMs: 0, endMs: 8_000 },
        { source: 'audio', startMs: 1_000, endMs: 2_500 },
      ]),
    ).toBe(2_500);
  });

  it('is zero when there are no audio segments', () => {
    expect(audioTranscribedMs([])).toBe(0);
    expect(audioTranscribedMs([{ source: 'captions', startMs: 0, endMs: 5_000 }])).toBe(0);
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
  it('shows extra precision under a cent and n/a when unknown', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.006)).toBe('$0.0060');
    expect(formatUsd(1.2)).toBe('$1.20');
    expect(formatUsd(null)).toBe('n/a');
    expect(formatUsd(undefined)).toBe('n/a');
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
