export interface ChunkerOptions {
  sampleRate: number;
  targetSeconds: number;
  maxSeconds: number;
  silenceThreshold: number;
  minSilenceMs: number;
}

export const CHUNK_TARGET_SECONDS = 12;
export const CHUNK_MAX_SECONDS = 20;

/**
 * Accumulates PCM frames and emits chunks cut on sustained silence after
 * targetSeconds, with a hard cut at maxSeconds so a chunk can never grow
 * unbounded during continuous speech.
 */
export class SilenceChunker {
  private frames: Float32Array[] = [];
  private samples = 0;
  private silentSamples = 0;

  constructor(private opts: ChunkerOptions) {}

  push(frame: Float32Array): Float32Array | null {
    this.frames.push(frame.slice(0));
    this.samples += frame.length;

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += (frame[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    this.silentSamples = rms < this.opts.silenceThreshold
      ? this.silentSamples + frame.length
      : 0;

    const { sampleRate, targetSeconds, maxSeconds, minSilenceMs } = this.opts;
    const pastTarget = this.samples >= targetSeconds * sampleRate;
    const sustainedSilence = this.silentSamples >= (minSilenceMs / 1000) * sampleRate;
    const pastMax = this.samples >= maxSeconds * sampleRate;

    if ((pastTarget && sustainedSilence) || pastMax) return this.drain();
    return null;
  }

  flush(): Float32Array | null {
    return this.samples > 0 ? this.drain() : null;
  }

  private drain(): Float32Array {
    const out = new Float32Array(this.samples);
    let off = 0;
    for (const f of this.frames) {
      out.set(f, off);
      off += f.length;
    }
    this.frames = [];
    this.samples = 0;
    this.silentSamples = 0;
    return out;
  }
}
