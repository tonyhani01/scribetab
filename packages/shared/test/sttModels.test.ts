import { describe, expect, it } from 'vitest';
import { STT_MODEL_CATALOG, isCuratedSttModel, sttModelCatalog } from '../src/sttModels';
import { TRANSCRIPTION_PROVIDER_IDS } from '../src/providers';

describe('STT model catalog', () => {
  it('covers every registered provider', () => {
    for (const id of TRANSCRIPTION_PROVIDER_IDS) expect(STT_MODEL_CATALOG[id]).toBeDefined();
  });

  it('offers the required labelled choices', () => {
    expect(sttModelCatalog('elevenlabs').choices).toEqual([
      { id: 'scribe_v2', label: 'Scribe v2 — Recommended' },
    ]);
    expect(sttModelCatalog('google').choices).toEqual([
      { id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe' },
    ]);
    expect(sttModelCatalog('openrouter').choices).toEqual([
      { id: 'openai/whisper-large-v3', label: 'Whisper Large v3 — Accuracy' },
      { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo — Budget' },
    ]);
    expect(sttModelCatalog('openai').choices).toEqual([
      { id: 'whisper-1', label: 'Whisper (whisper-1) — Recommended' },
    ]);
  });

  it('pins ElevenLabs and Google to curated ids but keeps custom paths elsewhere', () => {
    expect(sttModelCatalog('elevenlabs').allowCustom).toBe(false);
    expect(sttModelCatalog('google').allowCustom).toBe(false);
    for (const id of ['openai', 'groq', 'deepgram', 'mistral', 'openrouter', 'custom']) {
      expect(sttModelCatalog(id).allowCustom).toBe(true);
    }
  });

  it('explains Smart vs verbatim without claiming Smart supports timestamps', () => {
    const hint = sttModelCatalog('google').hint ?? '';
    expect(hint).toMatch(/verbatim/i);
    expect(hint).toMatch(/Smart mode .* without timestamps or diarization/i);
    expect(sttModelCatalog('elevenlabs').hint).toMatch(/multilingual \/ code-switched/);
  });

  it('treats blank and curated ids as curated, anything else as custom', () => {
    expect(isCuratedSttModel('openrouter', '')).toBe(true);
    expect(isCuratedSttModel('openrouter', 'openai/whisper-large-v3-turbo')).toBe(true);
    expect(isCuratedSttModel('openrouter', 'google/chirp-3')).toBe(false);
    expect(isCuratedSttModel('unknown', 'x')).toBe(false);
  });
});
