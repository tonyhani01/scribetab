import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistLastTranscriptionError } from '../utils/transcriptionError';

describe('persistLastTranscriptionError', () => {
  const storage: Record<string, unknown> = {};

  beforeEach(() => {
    for (const k of Object.keys(storage)) delete storage[k];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          set: async (v: Record<string, unknown>) => {
            Object.assign(storage, v);
          },
          remove: async (key: string) => {
            delete storage[key];
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets lastTranscriptionError on a bounded diagnostic', async () => {
    await persistLastTranscriptionError('rate limited');
    expect(storage.lastTranscriptionError).toBe('rate limited');
  });

  it('clears lastTranscriptionError on null', async () => {
    storage.lastTranscriptionError = 'stale';
    await persistLastTranscriptionError(null);
    expect(storage.lastTranscriptionError).toBeUndefined();
  });
});

describe('offscreen chrome API surface', () => {
  it('does not reference chrome.storage', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../entrypoints/offscreen/main.ts'),
      'utf8',
    );
    expect(src).not.toContain('chrome.storage');
  });
});
