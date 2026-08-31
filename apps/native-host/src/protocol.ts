import type {
  ActionItem,
  ExportActionsAck,
  ExportActionsMessage,
  GetUpcomingAck,
  GetUpcomingMessage,
  HostMessage,
  HostSyncAck,
  UpcomingEvent,
} from '@scribetab/shared';
import { loadConfig } from './config.js';
import { writeNativeMessage } from './framing.js';
import { fetchUpcomingEvents } from './ics.js';
import { integrationFollowUpError, runPostSyncIntegrations, sanitizeIntegrationError } from './integrations.js';
import { getMeeting } from './meetings.js';
import { appendActionItems, createNotionPage, loadNotionPageMap } from './notion.js';
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
const MAX_EXPORT_ITEMS = 200;
const MAX_ITEM_TEXT = 4000;
const MAX_ITEM_META = 200;
const MAX_UPCOMING_EVENTS = 50;
const UPCOMING_PROTOCOL_VERSION = 1;

export type NativeSyncHostOpts = {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
};

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

/** Diagnostic lines go to stderr only — stdout is the native messaging channel. */
function note(message: string): void {
  process.stderr.write(`[scribetab-host] ${message}\n`);
}

function chunkPayload(
  msg: Extract<HostMessage, { type: 'sync_audio_chunk' }>,
  format: string | undefined,
): string {
  const hasWav = typeof msg.wavBase64 === 'string';
  const hasData = typeof msg.dataBase64 === 'string';
  if (hasWav === hasData) {
    throw new Error('sync_audio_chunk requires exactly one of wavBase64 or dataBase64');
  }
  if (format === 'ogg-opus') {
    if (!hasData) throw new Error('ogg-opus sync requires dataBase64');
    return msg.dataBase64!;
  }
  if (format === 'wav') {
    if (!hasWav) throw new Error('wav sync requires wavBase64');
    return msg.wavBase64!;
  }
  return hasWav ? msg.wavBase64! : msg.dataBase64!;
}

function parseExportItems(raw: unknown): ActionItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ActionItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return undefined;
    const rec = it as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.text !== 'string') return undefined;
    const item: ActionItem = { id: rec.id, text: rec.text.slice(0, MAX_ITEM_TEXT) };
    if (typeof rec.owner === 'string') item.owner = rec.owner.slice(0, MAX_ITEM_META);
    if (typeof rec.due === 'string') item.due = rec.due.slice(0, MAX_ITEM_META);
    out.push(item);
  }
  return out;
}

export class NativeSyncHost {
  private inflight: InFlightSync | null = null;
  private silenced = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly opts: NativeSyncHostOpts;

  constructor(
    private readonly stdout: NodeJS.WritableStream,
    env: NodeJS.ProcessEnv = process.env,
    opts: NativeSyncHostOpts = {},
  ) {
    this.env = env;
    this.opts = opts;
  }

  async handle(raw: unknown): Promise<void> {
    if (this.silenced) return;
    try {
      await this.dispatch(raw as HostMessage);
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

  private async writeExportAck(ack: ExportActionsAck): Promise<void> {
    const out: ExportActionsAck = {
      ok: ack.ok,
      sessionId: cap(ack.sessionId, MAX_ACK_ID),
      results: ack.results.map((r) => ({
        id: r.id,
        ok: r.ok,
        ...(r.error ? { error: cap(r.error, MAX_ACK_ERROR) } : {}),
      })),
    };
    if (ack.error) out.error = cap(ack.error, MAX_ACK_ERROR);
    if (ack.pageUrl) out.pageUrl = ack.pageUrl;
    await writeNativeMessage(this.stdout, out);
  }

  private async dispatch(msg: HostMessage): Promise<void> {
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      throw new Error('Invalid HostMessage');
    }

    switch (msg.type) {
      case 'export_actions': {
        await this.exportActions(msg);
        return;
      }
      case 'get_upcoming': {
        await this.upcomingEvents(msg);
        return;
      }
      case 'sync_begin': {
        if (msg.protocolVersion !== 1 && msg.protocolVersion !== 2) {
          throw new Error(`Unsupported protocolVersion ${String(msg.protocolVersion)}`);
        }
        if (!msg.session?.id) throw new Error('sync_begin missing session.id');
        if (msg.audio) {
          const format = String(msg.audio.format);
          if (format !== 'wav' && format !== 'ogg-opus') {
            throw new Error(`Unsupported audio format ${format}`);
          }
          if (format === 'ogg-opus' && msg.protocolVersion !== 2) {
            throw new Error('ogg-opus requires protocolVersion 2');
          }
        }
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
        await appendAudioChunk(this.inflight, msg.index, chunkPayload(msg, this.inflight.audio?.format));
        return;
      }
      case 'sync_end': {
        if (!this.inflight) throw new Error('sync_end without sync_begin');
        if (msg.sessionId !== this.inflight.sessionId) {
          throw new Error('sessionId mismatch');
        }
        const sessionId = this.inflight.sessionId;
        const skipped = this.inflight.audioSkipped;
        const session = this.inflight.session;
        const segments = this.inflight.segments;
        const summaryMarkdown = this.inflight.summaryMarkdown;
        const dest = await commitSync(this.inflight, meetingsDir(this.env));
        this.inflight = null;
        await this.ok(sessionId, skipped ? `audio skipped: ${skipped}` : undefined);
        let followUp: string | undefined;
        try {
          const statuses = await runPostSyncIntegrations({
            session,
            segments,
            summaryMarkdown,
            meetingDir: dest,
            env: this.env,
            platform: this.opts.platform,
            fetchImpl: this.opts.fetchImpl,
          });
          followUp = integrationFollowUpError(statuses);
        } catch (e) {
          followUp = e instanceof Error ? e.message : String(e);
        }
        await this.ok(sessionId, followUp);
        return;
      }
      default:
        throw new Error(`Unknown message type: ${String((msg as { type: string }).type)}`);
    }
  }

  /**
   * Reply to `get_upcoming`. Deliberately never fails: a missing/unreadable calendar
   * must look identical to "no meetings", so the extension can fall back silently.
   * This path must also never silence the host (a later message on the same port is
   * still valid) and never touches `this.inflight` (a sync may be streaming).
   */
  private async upcomingEvents(msg: GetUpcomingMessage): Promise<void> {
    let events: UpcomingEvent[] = [];
    const protocolVersion = (msg as { protocolVersion?: unknown }).protocolVersion;
    try {
      if (protocolVersion !== UPCOMING_PROTOCOL_VERSION) {
        note(`ignoring get_upcoming with protocolVersion ${String(protocolVersion)}`);
      } else {
        const cfg = await loadConfig(this.env, this.opts.platform);
        const fetched = await fetchUpcomingEvents({
          icsUrl: cfg.icsUrl,
          fetchImpl: this.opts.fetchImpl,
        });
        events = fetched
          .slice(0, MAX_UPCOMING_EVENTS)
          .map((e) => ({ title: e.title, startMs: e.startMs, endMs: e.endMs }));
      }
    } catch (e) {
      // fetchUpcomingEvents is already best-effort; this only catches config errors.
      note(`get_upcoming failed: ${e instanceof Error ? e.message : String(e)}`);
      events = [];
    }
    const ack: GetUpcomingAck = { ok: true, events };
    await writeNativeMessage(this.stdout, ack);
  }

  private async exportActions(msg: ExportActionsMessage): Promise<void> {
    const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : 'unknown';
    let token: string | undefined;
    const fail = async (
      error: string,
      results: ExportActionsAck['results'] = [],
    ): Promise<void> => {
      await this.writeExportAck({
        ok: false,
        sessionId,
        error: sanitizeIntegrationError(error, token),
        results: results.map((r) => ({
          ...r,
          error: r.error ? sanitizeIntegrationError(r.error, token) : undefined,
        })),
      });
    };
    try {
      if (msg.protocolVersion !== 1) {
        await fail(`Unsupported protocolVersion ${String(msg.protocolVersion)}`);
        return;
      }
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        await fail('export_actions missing sessionId');
        return;
      }
      const items = parseExportItems(msg.items);
      if (!items) {
        await fail('export_actions items must be an array of {id, text} strings');
        return;
      }
      if (items.length > MAX_EXPORT_ITEMS) {
        await fail(`export_actions accepts at most ${MAX_EXPORT_ITEMS} items`);
        return;
      }
      const cfg = await loadConfig(this.env, this.opts.platform);
      token = cfg.notion?.token;
      if (!cfg.notionEnabled || !cfg.notion?.token || !cfg.notion?.parentPageId) {
        await fail(
          'Notion is not configured on the native host (run: scribetab-host config set …)',
        );
        return;
      }
      const pageMap = await loadNotionPageMap(this.env, this.opts.platform);
      const existing = pageMap[sessionId];
      let pageId: string;
      if (existing?.status === 'ok' && existing.pageId) {
        pageId = existing.pageId;
      } else {
        const meeting = await getMeeting(meetingsDir(this.env), sessionId);
        if (!meeting?.session) {
          await fail(
            'Meeting not synced to disk yet — stop the recording and wait for sync, then retry',
          );
          return;
        }
        const created = await createNotionPage({
          token: cfg.notion.token,
          parentPageId: cfg.notion.parentPageId,
          session: meeting.session,
          segments: meeting.segments,
          summaryMarkdown: meeting.summaryMd,
          fetchImpl: this.opts.fetchImpl,
          env: this.env,
          platform: this.opts.platform,
        });
        pageId = created.pageId;
      }
      const { results } = await appendActionItems({
        token: cfg.notion.token,
        pageId,
        sessionId,
        items,
        fetchImpl: this.opts.fetchImpl,
        env: this.env,
        platform: this.opts.platform,
      });
      await this.writeExportAck({
        ok: results.every((r) => r.ok),
        sessionId,
        results: results.map((r) => ({
          ...r,
          error: r.error ? sanitizeIntegrationError(r.error, token) : undefined,
        })),
        pageUrl: `https://www.notion.so/${pageId.replace(/-/g, '')}`,
      });
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
    }
  }
}
