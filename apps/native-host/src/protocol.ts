import type { HostSyncAck, HostSyncMessage } from '@scribetab/shared';
import { writeNativeMessage } from './framing.js';
import { meetingsDir } from './paths.js';
import {
  abortSync,
  appendAudioChunk,
  beginSync,
  type InFlightSync,
  commitSync,
} from './sessionWriter.js';

const MAX_ACK_ERROR = 1000;
const MAX_ACK_ID = 80;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function sessionIdOf(msg: unknown): string {
  if (isRecord(msg) && typeof msg.sessionId === 'string') return msg.sessionId;
  if (isRecord(msg) && isRecord(msg.session) && typeof msg.session.id === 'string') {
    return msg.session.id;
  }
  return 'unknown';
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

export class NativeSyncHost {
  private inflight: InFlightSync | null = null;
  private silenced = false;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly stdout: NodeJS.WritableStream,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = env;
  }

  async handle(raw: unknown): Promise<void> {
    if (this.silenced) return;
    try {
      await this.dispatch(raw as HostSyncMessage);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.fail(sessionIdOf(raw), error);
    }
  }

  async shutdown(): Promise<void> {
    await abortSync(this.inflight);
    this.inflight = null;
  }

  private async fail(sessionId: string, error: string): Promise<void> {
    await abortSync(this.inflight);
    this.inflight = null;
    this.silenced = true;
    const ack: HostSyncAck = {
      ok: false,
      sessionId: cap(sessionId, MAX_ACK_ID),
      error: cap(error, MAX_ACK_ERROR),
    };
    await writeNativeMessage(this.stdout, ack);
  }

  private async ok(sessionId: string, error?: string): Promise<void> {
    const ack: HostSyncAck = {
      ok: true,
      sessionId: cap(sessionId, MAX_ACK_ID),
      ...(error ? { error: cap(error, MAX_ACK_ERROR) } : {}),
    };
    await writeNativeMessage(this.stdout, ack);
  }

  private async dispatch(msg: HostSyncMessage): Promise<void> {
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      throw new Error('Invalid HostSyncMessage');
    }

    switch (msg.type) {
      case 'sync_begin': {
        if (msg.protocolVersion !== 1) {
          throw new Error(`Unsupported protocolVersion ${String(msg.protocolVersion)}`);
        }
        if (!msg.session?.id) throw new Error('sync_begin missing session.id');
        if (this.inflight) {
          await abortSync(this.inflight);
          this.inflight = null;
        }
        this.inflight = await beginSync(meetingsDir(this.env), msg.session, msg.segments ?? [], {
          summaryMarkdown: msg.summaryMarkdown,
          audio: msg.audio,
        });
        return;
      }
      case 'sync_audio_chunk': {
        if (!this.inflight) throw new Error('sync_audio_chunk without sync_begin');
        if (msg.sessionId !== this.inflight.sessionId) {
          throw new Error('sessionId mismatch');
        }
        await appendAudioChunk(this.inflight, msg.index, msg.wavBase64);
        return;
      }
      case 'sync_end': {
        if (!this.inflight) throw new Error('sync_end without sync_begin');
        if (msg.sessionId !== this.inflight.sessionId) {
          throw new Error('sessionId mismatch');
        }
        const sessionId = this.inflight.sessionId;
        const skipped = this.inflight.audioSkipped;
        await commitSync(this.inflight, meetingsDir(this.env));
        this.inflight = null;
        await this.ok(sessionId, skipped ? `audio skipped: ${skipped}` : undefined);
        return;
      }
      default:
        throw new Error(`Unknown message type: ${String((msg as { type: string }).type)}`);
    }
  }
}
