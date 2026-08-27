import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav, muxOggOpus } from '@scribetab/shared';
import { assembleRecording } from '../utils/assemble';
import { putChunk } from '../utils/chunkStore';
import { closeDb } from '../utils/db';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/** SILK 20 ms (TOC config 1, code 0) → 960 samples at 48 kHz. */
function oggBytes(serial: number): ArrayBuffer {
  return muxOggOpus(
    [{ data: new Uint8Array([8, 0, 1, 2]), frameSamples48k: 960 }],
    { inputSampleRate: 16_000, serial },
  );
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
});

afterEach(async () => {
  await closeDb();
  await deleteDb();
});

describe('assembleRecording', () => {
  it('returns a controlled empty result when no audio was retained', async () => {
    const result = await assembleRecording('missing');
    expect(result.seconds).toBe(0);
    expect(result.blob.size).toBe(0);
    expect(result.blob.type).toBe('audio/wav');
    expect(result.ext).toBe('wav');
  });

  it('assembles retained WAV chunks', async () => {
    const wav = encodeWav(new Float32Array(16), 16_000);
    await putChunk({
      sessionId: 's1',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav,
      createdAt: 1,
    });
    const result = await assembleRecording('s1');
    expect(result.seconds).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(44);
    expect(result.blob.type).toBe('audio/wav');
    expect(result.ext).toBe('wav');
  });

  it('remuxes all-ogg-opus rows and uses durationMs for seconds', async () => {
    await putChunk({
      sessionId: 's2',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav: oggBytes(0),
      format: 'ogg-opus',
      durationMs: 1000,
      createdAt: 1,
    });
    await putChunk({
      sessionId: 's2',
      index: 1,
      sampleRate: 16_000,
      startOffsetSamples: 16_000,
      wav: oggBytes(1),
      format: 'ogg-opus',
      durationMs: 500,
      createdAt: 2,
    });
    const result = await assembleRecording('s2');
    expect(result.ext).toBe('ogg');
    expect(result.blob.type).toBe('audio/ogg');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.seconds).toBe(1.5);
  });

  it('derives ogg seconds from granule when durationMs is missing', async () => {
    await putChunk({
      sessionId: 's3',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav: oggBytes(0),
      format: 'ogg-opus',
      createdAt: 1,
    });
    const result = await assembleRecording('s3');
    expect(result.ext).toBe('ogg');
    expect(result.seconds).toBeCloseTo(960 / 48_000, 8);
  });

  it('throws when a session mixes ogg-opus and wav rows', async () => {
    const wav = encodeWav(new Float32Array(16), 16_000);
    await putChunk({
      sessionId: 's4',
      index: 0,
      sampleRate: 16_000,
      startOffsetSamples: 0,
      wav,
      createdAt: 1,
    });
    await putChunk({
      sessionId: 's4',
      index: 1,
      sampleRate: 16_000,
      startOffsetSamples: 16,
      wav: oggBytes(1),
      format: 'ogg-opus',
      durationMs: 20,
      createdAt: 2,
    });
    await expect(assembleRecording('s4')).rejects.toThrow(
      'Recording mixes audio formats; download is unavailable for this session',
    );
  });

});
