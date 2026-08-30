import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { muxOggOpus, wavHeader } from '@scribetab/shared';
import {
  PLAYBACK_RATES,
  SEEK_STEP_MS,
  assembleSessionAudio,
  loadSessionAudio,
  playbackKeyAction,
  playingSegmentIndex,
  revokeSessionAudio,
} from '../utils/playback';
import { putChunk, type ChunkRow } from '../utils/chunkStore';
import { closeDb } from '../utils/db';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/** 16-bit mono WAV chunk with `pcmBytes` of recognisable payload. */
function wavChunk(index: number, pcmBytes: number, sampleRate = 16_000): Omit<ChunkRow, 'sessionId'> {
  const wav = new ArrayBuffer(44 + pcmBytes);
  new Uint8Array(wav).set(new Uint8Array(wavHeader(pcmBytes, sampleRate)), 0);
  const pcm = new Uint8Array(wav, 44);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (index * 16 + i) % 251;
  return {
    index,
    sampleRate,
    startOffsetSamples: index * (pcmBytes / 2),
    wav,
    createdAt: index + 1,
  };
}

/** SILK 20 ms (TOC config 1, code 0) → 960 samples at 48 kHz. */
function oggChunk(index: number): Omit<ChunkRow, 'sessionId'> {
  return {
    index,
    sampleRate: 16_000,
    startOffsetSamples: index * 16_000,
    wav: muxOggOpus([{ data: new Uint8Array([8, 0, 1, 2]), frameSamples48k: 960 }], {
      inputSampleRate: 16_000,
      serial: index,
    }),
    format: 'ogg-opus',
    durationMs: 1000,
    createdAt: index + 1,
  };
}

const put = (row: ChunkRow) => putChunk({ ...row, sessionId: 'playback' });

beforeEach(async () => {
  await closeDb();
  await deleteDb();
});

afterEach(async () => {
  await closeDb();
  await deleteDb();
});

describe('loadSessionAudio', () => {
  it('returns null when the session retained no chunks', async () => {
    expect(await loadSessionAudio('playback')).toBeNull();
  });

  it('concatenates WAV chunks under one patched RIFF header', async () => {
    await put(wavChunk(0, 32));
    await put(wavChunk(1, 16));
    const audio = await loadSessionAudio('playback');
    expect(audio).not.toBeNull();

    const bytes = new Uint8Array(await audio!.blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...bytes.subarray(off, off + len));

    expect(bytes.byteLength).toBe(44 + 32 + 16);
    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 32 + 16); // RIFF size = 36 + data
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(32 + 16); // data size = summed PCM
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate from chunk 0
    expect(audio!.seconds).toBe(48 / 2 / 16_000);
    expect(audio!.mimeType).toBe('audio/wav');
    // PCM is copied verbatim, in index order, with the per-chunk headers dropped.
    expect(bytes.subarray(44, 46)).toEqual(new Uint8Array([0, 1]));
    expect(bytes.subarray(44 + 32, 44 + 32 + 3)).toEqual(new Uint8Array([16, 17, 18]));
  });

  it('exposes ogg-opus sessions as a single OGG stream', async () => {
    await put(oggChunk(0));
    await put(oggChunk(1));
    const audio = await loadSessionAudio('playback');
    expect(audio!.mimeType).toBe('audio/ogg');
    expect(audio!.seconds).toBe(2);
    expect(audio!.blob.size).toBeGreaterThan(0);
  });

  it('rejects a session that mixes WAV and Opus rows', async () => {
    await put(wavChunk(0, 32));
    await put(oggChunk(1));
    await expect(loadSessionAudio('playback')).rejects.toThrow('mixes audio formats');
  });
});

describe('assembleSessionAudio / revokeSessionAudio', () => {
  it('returns null when there is nothing to play', async () => {
    expect(await assembleSessionAudio('playback')).toBeNull();
  });

  it('hands back a blob URL for the assembled recording', async () => {
    await put(wavChunk(0, 32));
    const source = await assembleSessionAudio('playback');
    expect(source).not.toBeNull();
    expect(source!.url).toMatch(/^blob:/);
    expect(source!.mimeType).toBe('audio/wav');
    expect(Object.keys(source!).sort()).toEqual(['mimeType', 'url']);
    expect(() => revokeSessionAudio(source!.url)).not.toThrow();
  });

  it('tolerates revoking an empty or already-revoked URL', () => {
    expect(() => revokeSessionAudio('')).not.toThrow();
    expect(() => revokeSessionAudio('blob:already-gone')).not.toThrow();
  });
});

describe('playingSegmentIndex', () => {
  const segments = [
    { id: 'a', startMs: 1000, endMs: 2000 },
    { id: 'b', startMs: 5000, endMs: 6000 },
  ];

  it('is -1 with no segments or before the first one', () => {
    expect(playingSegmentIndex([], 1500)).toBe(-1);
    expect(playingSegmentIndex(segments, 0)).toBe(-1);
  });

  it('only marks a segment while the playback time is inside its bounds', () => {
    expect(playingSegmentIndex(segments, 1000)).toBe(0);
    expect(playingSegmentIndex(segments, 1999)).toBe(0);
    expect(playingSegmentIndex(segments, 2000)).toBe(-1);
    expect(playingSegmentIndex(segments, 4200)).toBe(-1);
    expect(playingSegmentIndex(segments, 5000)).toBe(1);
    expect(playingSegmentIndex(segments, 6000)).toBe(-1);
    expect(playingSegmentIndex(segments, 90_000)).toBe(-1);
  });
});

describe('playbackKeyAction', () => {
  it('maps Escape and the arrow keys to player commands', () => {
    expect(playbackKeyAction('Escape', null)).toBe('toggle');
    expect(playbackKeyAction('ArrowLeft', null)).toBe('seek-back');
    expect(playbackKeyAction('ArrowRight', null)).toBe('seek-forward');
    expect(playbackKeyAction(' ', null)).toBeNull();
  });

  it('stays out of the way while the user is typing', () => {
    expect(playbackKeyAction('Escape', { tagName: 'INPUT' })).toBeNull();
    expect(playbackKeyAction('ArrowLeft', { tagName: 'TEXTAREA' })).toBeNull();
    expect(playbackKeyAction('ArrowRight', { tagName: 'SELECT' })).toBeNull();
    expect(playbackKeyAction('Escape', { tagName: 'DIV', isContentEditable: true })).toBeNull();
  });

  it('uses the documented seek step and speed choices', () => {
    expect(SEEK_STEP_MS).toBe(5000);
    expect(PLAYBACK_RATES).toEqual([1, 1.25, 1.5, 2]);
  });
});
