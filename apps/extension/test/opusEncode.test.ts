import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeChunkToOggOpus, opusPacketsCoverInput } from '../utils/opusEncode';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opusPacketsCoverInput', () => {
  it('accepts exact 48 kHz cover of the 16 kHz input', () => {
    expect(opusPacketsCoverInput([{ frameSamples48k: 960 }], 320)).toBe(true);
  });

  it('accepts one 20 ms frame of encoder padding', () => {
    expect(opusPacketsCoverInput([{ frameSamples48k: 960 }], 160)).toBe(true);
  });

  it('rejects missing packets (DTX / gaps)', () => {
    expect(opusPacketsCoverInput([{ frameSamples48k: 960 }], 16_000)).toBe(false);
  });

  it('rejects an empty packet list', () => {
    expect(opusPacketsCoverInput([], 320)).toBe(false);
  });
});

describe('encodeChunkToOggOpus', () => {
  it('returns null when WebCodecs AudioEncoder is unavailable', async () => {
    expect(typeof (globalThis as { AudioEncoder?: unknown }).AudioEncoder).toBe('undefined');
    await expect(encodeChunkToOggOpus(new Float32Array(320), 0)).resolves.toBeNull();
  });

  it('returns null when packets end up empty', async () => {
    class FakeAudioData {
      constructor(_init: unknown) {}
      close(): void {}
    }
    class FakeAudioEncoder {
      static isConfigSupported = async () => ({ supported: true });
      state = 'configured';
      constructor(_init: { output: (chunk: unknown) => void; error: () => void }) {}
      configure(): void {}
      encode(): void {}
      flush(): Promise<void> {
        return Promise.resolve();
      }
      close(): void {
        this.state = 'closed';
      }
    }
    vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
    vi.stubGlobal('AudioData', FakeAudioData);
    await expect(encodeChunkToOggOpus(new Float32Array(320), 0)).resolves.toBeNull();
  });
});
