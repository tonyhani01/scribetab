import { describe, expect, it, vi } from 'vitest';
import {
  FAILED_SEGMENT_TEXT,
  TranscriptionQueue,
  segmentsFromResult,
} from '../src/transcriptionQueue';
import type { TranscriptSegment } from '../src/types';

const job = (index: number, startMs = index * 45_000): { index: number; wav: ArrayBuffer; startMs: number; durationMs: number } =>
  ({ index, wav: new ArrayBuffer(4), startMs, durationMs: 45_000 });

let n = 0;
const ids = () => `id-${n++}`;

describe('segmentsFromResult', () => {
  it('offsets provider segments by the chunk start and trims empties', () => {
    const segs = segmentsFromResult(
      { text: 'x', segments: [
        { startMs: 0, endMs: 1000, text: ' hello ' },
        { startMs: 1000, endMs: 2000, text: '   ' },
      ] },
      job(2, 90_000), 's1', ids,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      sessionId: 's1', startMs: 90_000, endMs: 91_000, text: 'hello', source: 'audio',
    });
  });

  it('carries provider speaker labels onto stored segments', () => {
    const segs = segmentsFromResult(
      { text: 'x', segments: [
        { startMs: 0, endMs: 1000, text: 'hi', speaker: 'Speaker 1' },
        { startMs: 1000, endMs: 2000, text: 'yo' },
      ] },
      job(0), 's1', ids,
    );
    expect(segs[0]!.speaker).toBe('Speaker 1');
    expect('speaker' in segs[1]!).toBe(false);
  });

  it('falls back to one whole-chunk segment when the provider returns only text', () => {
    const segs = segmentsFromResult({ text: ' just text ' }, job(0), 's1', ids);
    expect(segs).toEqual([expect.objectContaining({
      startMs: 0, endMs: 45_000, text: 'just text', source: 'audio',
    })]);
  });

  it('returns nothing for silent chunks (empty text, no segments)', () => {
    expect(segmentsFromResult({ text: '  ' }, job(0), 's1', ids)).toEqual([]);
  });
});

describe('TranscriptionQueue', () => {
  it('transcribes a job and delivers mapped segments', async () => {
    const got: TranscriptSegment[][] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'hi' }),
      onSegments: (s) => { got.push(s); },
      makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(got).toHaveLength(1);
    expect(got[0]![0]!.text).toBe('hi');
  });

  it('passes the language hint through', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: 'x' });
    const q = new TranscriptionQueue({
      sessionId: 's1', transcribe, onSegments: () => {}, language: 'sv', makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/wav', language: 'sv' }),
    );
  });

  it('retries with 1s/4s/16s backoff then succeeds', async () => {
    const delays: number[] = [];
    const transcribe = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ text: 'third time' });
    const got: TranscriptSegment[][] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1', transcribe,
      onSegments: (s) => { got.push(s); },
      sleep: async (ms) => { delays.push(ms); },
      makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(delays).toEqual([1000, 4000]);
    expect(got[0]![0]!.text).toBe('third time');
  });

  it('emits a gap segment after all retries fail — never silent loss', async () => {
    const delays: number[] = [];
    const got: TranscriptSegment[][] = [];
    const errors: string[] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockRejectedValue(new Error('google: HTTP 400 bad model')),
      onSegments: (s) => { got.push(s); },
      onError: (m) => { errors.push(m); },
      sleep: async (ms) => { delays.push(ms); },
      makeId: ids,
    });
    q.enqueue(job(3, 135_000));
    await q.drain();
    expect(delays).toEqual([1000, 4000, 16000]);
    expect(got[0]).toEqual([expect.objectContaining({
      text: FAILED_SEGMENT_TEXT, startMs: 135_000, endMs: 180_000, source: 'audio',
    })]);
    expect(errors[errors.length - 1]).toBe('google: HTTP 400 bad model');
  });

  it('forwards provider-computed costUsd', async () => {
    const costs: number[] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'hi', costUsd: 0.00003036 }),
      onSegments: () => {},
      onCostUsd: (n) => { costs.push(n); },
      makeId: ids,
    });
    q.enqueue(job(0));
    await q.drain();
    expect(costs).toEqual([0.00003036]);
  });

  it('processes jobs strictly in order', async () => {
    const order: number[] = [];
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: async (req) => {
        // first job is slow — order must still hold
        if (req.audio.byteLength === 8) await new Promise((r) => setTimeout(r, 20));
        return { text: String(req.audio.byteLength) };
      },
      onSegments: (s) => { order.push(Number(s[0]!.text)); },
      makeId: ids,
    });
    q.enqueue({ index: 0, wav: new ArrayBuffer(8), startMs: 0, durationMs: 1000 });
    q.enqueue({ index: 1, wav: new ArrayBuffer(4), startMs: 1000, durationMs: 1000 });
    await q.drain();
    expect(order).toEqual([8, 4]);
  });

  it('a throwing onSegments does not break later jobs', async () => {
    const got: string[] = [];
    let first = true;
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
      onSegments: () => {
        if (first) { first = false; throw new Error('idb full'); }
        got.push('delivered');
      },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(got).toEqual(['delivered']);
  });

  it('cancel() stops retrying and suppresses delivery', async () => {
    const onSegments = vi.fn();
    let sleeps = 0;
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockRejectedValue(new Error('down')),
      onSegments,
      sleep: async () => { sleeps++; q.cancel(); },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(sleeps).toBe(1);            // cancelled during first backoff
    expect(onSegments).not.toHaveBeenCalled(); // no gap segment either — session was abandoned
  });

  it('onJobStart fires once per job before the first attempt, including retries', async () => {
    const order: string[] = [];
    const transcribe = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ text: 'ok' });
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: async (req) => {
        order.push('transcribe');
        return transcribe(req);
      },
      onJobStart: (job) => { order.push(`start:${job.index}`); },
      onSegments: (_s, job) => { order.push(`segments:${job.index}`); },
      sleep: async () => { order.push('retry'); },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(order).toEqual([
      'start:0', 'transcribe', 'retry', 'transcribe', 'segments:0',
      'start:1', 'transcribe', 'segments:1',
    ]);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it('onSegments receives the job on success and on the failure-marker path', async () => {
    const got: { text: string; index: number }[] = [];
    const ok = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'hi' }),
      onSegments: (s, j) => { got.push({ text: s[0]!.text, index: j.index }); },
      makeId: ids,
    });
    ok.enqueue(job(2, 90_000));
    await ok.drain();

    const fail = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockRejectedValue(new Error('down')),
      onSegments: (s, j) => { got.push({ text: s[0]!.text, index: j.index }); },
      sleep: async () => {},
      makeId: ids,
    });
    fail.enqueue(job(4, 180_000));
    await fail.drain();

    expect(got).toEqual([
      { text: 'hi', index: 2 },
      { text: FAILED_SEGMENT_TEXT, index: 4 },
    ]);
  });

  it('successful empty/whitespace text skips onSegments but still calls onJobDone', async () => {
    const onSegments = vi.fn();
    const onJobDone = vi.fn();
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: '  ' }),
      onSegments,
      onJobDone,
      makeId: ids,
    });
    const j = job(3);
    q.enqueue(j);
    await q.drain();
    expect(onSegments).not.toHaveBeenCalled();
    expect(onJobDone).toHaveBeenCalledTimes(1);
    expect(onJobDone).toHaveBeenCalledWith(j);
  });

  it('onSegments rejection still fires onJobDone and proceeds to the next job', async () => {
    const done: number[] = [];
    const got: string[] = [];
    let first = true;
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
      onSegments: () => {
        if (first) { first = false; return Promise.reject(new Error('idb full')); }
        got.push('delivered');
      },
      onJobDone: (job) => { done.push(job.index); },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(done).toEqual([0, 1]);
    expect(got).toEqual(['delivered']);
  });

  it('onJobDone is not called after cancel()', async () => {
    const onJobDone = vi.fn();
    let sleeps = 0;
    const q = new TranscriptionQueue({
      sessionId: 's1',
      transcribe: vi.fn().mockRejectedValue(new Error('down')),
      onSegments: () => {},
      onJobDone,
      sleep: async () => { sleeps++; q.cancel(); },
      makeId: ids,
    });
    q.enqueue(job(0));
    q.enqueue(job(1));
    await q.drain();
    expect(sleeps).toBe(1);
    expect(onJobDone).not.toHaveBeenCalled();
  });
});
