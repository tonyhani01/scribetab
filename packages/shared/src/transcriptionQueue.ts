import type { TranscribeRequest, TranscribeResult, TranscriptSegment } from './types.js';

export interface TranscriptionJob {
  index: number;
  wav: ArrayBuffer;
  startMs: number;
  durationMs: number;
}

export interface TranscriptionQueueOptions {
  sessionId: string;
  transcribe: (req: TranscribeRequest) => Promise<TranscribeResult>;
  onSegments: (segments: TranscriptSegment[]) => void | Promise<void>;
  /** Most recent provider error, already bounded. */
  onError?: (message: string) => void | Promise<void>;
  /** Provider-computed chunk cost when present (e.g. OpenRouter usage.cost). */
  onCostUsd?: (usd: number) => void | Promise<void>;
  language?: string;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  makeId?: () => string;
}

export const FAILED_SEGMENT_TEXT = '[transcription failed]';
const DEFAULT_DELAYS = [1000, 4000, 16000];

export function segmentsFromResult(
  result: TranscribeResult,
  job: TranscriptionJob,
  sessionId: string,
  makeId: () => string,
): TranscriptSegment[] {
  if (result.segments && result.segments.length > 0) {
    return result.segments
      .filter((s) => s.text.trim().length > 0)
      .map((s) => ({
        id: makeId(),
        sessionId,
        startMs: job.startMs + s.startMs,
        endMs: job.startMs + s.endMs,
        text: s.text.trim(),
        source: 'audio' as const,
      }));
  }
  const text = result.text.trim();
  if (!text) return [];
  return [{
    id: makeId(),
    sessionId,
    startMs: job.startMs,
    endMs: job.startMs + job.durationMs,
    text,
    source: 'audio' as const,
  }];
}

/**
 * Serialized FIFO transcription pipeline: one chunk in flight at a time (keeps
 * segment delivery ordered and providers un-hammered), exponential backoff per
 * chunk, and a marked gap segment after final failure — a flaky network means
 * "transcript arrives late", never "audio lost" silently.
 */
export class TranscriptionQueue {
  private chain: Promise<void> = Promise.resolve();
  private cancelled = false;

  constructor(private opts: TranscriptionQueueOptions) {}

  enqueue(job: TranscriptionJob): void {
    this.chain = this.chain.then(() => this.process(job)).catch(() => {});
  }

  drain(): Promise<void> {
    return this.chain;
  }

  /** Abandon the session: stop retrying, deliver nothing further. */
  cancel(): void {
    this.cancelled = true;
  }

  private async process(job: TranscriptionJob): Promise<void> {
    if (this.cancelled) return;
    const delays = this.opts.retryDelaysMs ?? DEFAULT_DELAYS;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const makeId = this.opts.makeId ?? (() => crypto.randomUUID());

    let result: TranscribeResult | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await this.opts.transcribe({
          audio: job.wav,
          mimeType: 'audio/wav',
          language: this.opts.language,
        });
        break;
      } catch (e) {
        const message = (e instanceof Error && e.message ? e.message : String(e)).slice(0, 200);
        try {
          await this.opts.onError?.(message);
        } catch {
          // persist failures must not change retry behavior
        }
        if (this.cancelled || attempt >= delays.length) break;
        await sleep(delays[attempt]!);
        if (this.cancelled) break;
      }
    }
    if (this.cancelled) return;

    if (result && typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) && result.costUsd >= 0) {
      try {
        await this.opts.onCostUsd?.(result.costUsd);
      } catch {
        // cost persist failures must not drop segments
      }
    }

    const segments = result
      ? segmentsFromResult(result, job, this.opts.sessionId, makeId)
      : [{
          id: makeId(),
          sessionId: this.opts.sessionId,
          startMs: job.startMs,
          endMs: job.startMs + job.durationMs,
          text: FAILED_SEGMENT_TEXT,
          source: 'audio' as const,
        }];
    if (segments.length > 0) await this.opts.onSegments(segments);
  }
}
