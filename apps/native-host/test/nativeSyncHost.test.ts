import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  ExportActionsAck,
  HostSyncAck,
  MeetingSession,
  TranscriptSegment,
} from '@scribetab/shared';
import { saveConfig } from '../src/config.js';
import { saveNotionPageMap } from '../src/notion.js';
import { NativeSyncHost } from '../src/protocol.js';
import { withHome } from './helpers.js';

const session: MeetingSession = {
  id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: 'Host Unit',
  startedAt: '2026-08-27T12:00:00.000Z',
  platform: 'other',
  status: 'complete',
};

const segments: TranscriptSegment[] = [
  {
    id: 'seg-1',
    sessionId: session.id,
    startMs: 0,
    endMs: 10,
    text: 'hello',
    source: 'audio',
  },
];

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, '.local', 'share') };
}

function capturingStdout() {
  const bufs: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      bufs.push(Buffer.from(chunk as Buffer));
      cb();
    },
  });
  function messages(): unknown[] {
    const buf = Buffer.concat(bufs);
    const out: unknown[] = [];
    let i = 0;
    while (i + 4 <= buf.length) {
      const len = buf.readUInt32LE(i);
      i += 4;
      if (i + len > buf.length) break;
      out.push(JSON.parse(buf.subarray(i, i + len).toString('utf8')));
      i += len;
    }
    return out;
  }
  function acks(): HostSyncAck[] {
    return messages() as HostSyncAck[];
  }
  return { stdout, acks, messages };
}

function isExportAck(v: unknown): v is ExportActionsAck {
  return typeof v === 'object' && v !== null && Array.isArray((v as ExportActionsAck).results);
}

describe('NativeSyncHost integrations', () => {
  it('acks ok before a Notion failure and records status beside the meeting', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      const { stdout, acks } = capturingStdout();
      let fetchStarted = false;
      let resolveFetch: ((r: Response) => void) | undefined;
      const fetchImpl: typeof fetch = () =>
        new Promise((resolve) => {
          fetchStarted = true;
          resolveFetch = resolve;
        });
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 1,
        session,
        segments,
      });
      const end = host.handle({ type: 'sync_end', sessionId: session.id });
      const deadline = Date.now() + 3000;
      while ((!fetchStarted || acks().length < 1) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const first = acks();
      expect(first).toEqual([{ ok: true, sessionId: session.id }]);
      expect(fetchStarted).toBe(true);
      resolveFetch!(new Response('nope', { status: 401 }));
      await end;
      const both = acks();
      expect(both).toHaveLength(2);
      expect(both[1]?.ok).toBe(true);
      expect(both[1]?.error).toMatch(/401/);
      expect(both[1]?.error).not.toContain('ntn_secret_value');

      const meetings = join(home, 'ScribeTab', 'meetings');
      const dirs = (await readdir(meetings)).filter((n) => !n.startsWith('.'));
      expect(dirs).toHaveLength(1);
      const status = JSON.parse(
        await readFile(join(meetings, dirs[0]!, 'integrations.json'), 'utf8'),
      ) as { notion: { ok: boolean; message: string } };
      expect(status.notion.ok).toBe(false);
      expect(status.notion.message).toMatch(/401/);
      expect(status.notion.message).not.toContain('ntn_secret_value');
    });
  });
});

describe('NativeSyncHost protocol v2', () => {
  it('accepts protocolVersion 2 and writes audio.ogg', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      const payload = Buffer.from('ogg-bytes-verbatim');
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 2,
        session,
        segments,
        audio: { format: 'ogg-opus', totalChunks: 1 },
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 0,
        dataBase64: payload.toString('base64'),
      });
      await host.handle({ type: 'sync_end', sessionId: session.id });
      expect(acks()[0]).toEqual({ ok: true, sessionId: session.id });

      const meetings = join(home, 'ScribeTab', 'meetings');
      const dirs = (await readdir(meetings)).filter((n) => !n.startsWith('.'));
      expect(dirs).toHaveLength(1);
      const dest = join(meetings, dirs[0]!);
      expect(existsSync(join(dest, 'audio.ogg'))).toBe(true);
      expect(existsSync(join(dest, 'audio.wav'))).toBe(false);
      expect(await readFile(join(dest, 'audio.ogg'))).toEqual(payload);
    });
  });

  it('rejects an unsupported protocolVersion', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 3,
        session,
        segments,
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toBe('Unsupported protocolVersion 3');
    });
  });

  it('rejects sync_audio_chunk with neither payload field', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 2,
        session,
        segments,
        audio: { format: 'ogg-opus', totalChunks: 1 },
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 0,
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toMatch(/exactly one of wavBase64 or dataBase64/);
    });
  });

  it('rejects sync_audio_chunk with both payload fields', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 1,
        session,
        segments,
        audio: { format: 'wav', sampleRate: 16000, totalChunks: 1 },
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 0,
        wavBase64: Buffer.from('aa').toString('base64'),
        dataBase64: Buffer.from('bb').toString('base64'),
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toMatch(/exactly one of wavBase64 or dataBase64/);
    });
  });

  it('rejects protocolVersion 1 with ogg-opus audio', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 1,
        session,
        segments,
        audio: { format: 'ogg-opus', totalChunks: 1 },
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toMatch(/ogg-opus requires protocolVersion 2/);
    });
  });

  it('rejects an unknown audio format', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 2,
        session,
        segments,
        audio: { format: 'mp3', totalChunks: 1 },
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toBe('Unsupported audio format mp3');
    });
  });

  it('rejects wav sync with dataBase64', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 1,
        session,
        segments,
        audio: { format: 'wav', sampleRate: 16000, totalChunks: 1 },
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 0,
        dataBase64: Buffer.from('aa').toString('base64'),
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toMatch(/wav sync requires wavBase64/);
    });
  });

  it('rejects ogg-opus sync with wavBase64', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 2,
        session,
        segments,
        audio: { format: 'ogg-opus', totalChunks: 1 },
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 0,
        wavBase64: Buffer.from('aa').toString('base64'),
      });
      expect(acks()[0]?.ok).toBe(false);
      expect(acks()[0]?.error).toMatch(/ogg-opus sync requires dataBase64/);
    });
  });

  it('reassembles multi-slice ogg-opus into byte-identical audio.ogg', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, acks } = capturingStdout();
      const host = new NativeSyncHost(stdout, env, { platform: 'linux' });
      const a = Buffer.from('ogg-slice-one');
      const b = Buffer.from('ogg-slice-two-more');
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 2,
        session,
        segments,
        audio: { format: 'ogg-opus', totalChunks: 2 },
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 0,
        dataBase64: a.toString('base64'),
      });
      await host.handle({
        type: 'sync_audio_chunk',
        sessionId: session.id,
        index: 1,
        dataBase64: b.toString('base64'),
      });
      await host.handle({ type: 'sync_end', sessionId: session.id });
      expect(acks()[0]).toEqual({ ok: true, sessionId: session.id });

      const meetings = join(home, 'ScribeTab', 'meetings');
      const dirs = (await readdir(meetings)).filter((n) => !n.startsWith('.'));
      expect(dirs).toHaveLength(1);
      const dest = join(meetings, dirs[0]!);
      expect(await readFile(join(dest, 'audio.ogg'))).toEqual(Buffer.concat([a, b]));
      expect(existsSync(join(dest, 'audio.wav'))).toBe(false);
    });
  });
});

const exportItems = [
  { id: 'a1', text: 'Send deck', owner: 'Sam', due: 'Fri' },
  { id: 'a2', text: 'Book the room' },
];

describe('NativeSyncHost export_actions', () => {
  it('rejects an unsupported protocolVersion with a failed export ack', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, messages } = capturingStdout();
      let fetches = 0;
      const fetchImpl: typeof fetch = async () => {
        fetches += 1;
        return new Response('{}', { status: 200 });
      };
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 2,
        sessionId: session.id,
        items: exportItems,
      });
      const ack = messages()[0] as ExportActionsAck;
      expect(ack.ok).toBe(false);
      expect(ack.sessionId).toBe(session.id);
      expect(ack.error).toMatch(/protocolVersion/);
      expect(ack.results).toEqual([]);
      expect(fetches).toBe(0);
    });
  });

  it('replies ok:false when Notion is unconfigured and does not fetch', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const { stdout, messages } = capturingStdout();
      let fetches = 0;
      const fetchImpl: typeof fetch = async () => {
        fetches += 1;
        return new Response('{}', { status: 200 });
      };
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: exportItems,
      });
      const acks = messages();
      expect(acks).toHaveLength(1);
      expect(isExportAck(acks[0])).toBe(true);
      const ack = acks[0] as ExportActionsAck;
      expect(ack.ok).toBe(false);
      expect(ack.sessionId).toBe(session.id);
      expect(ack.error).toMatch(/config/i);
      expect(ack.results).toEqual([]);
      expect(fetches).toBe(0);
    });
  });

  it('appends heading and to_dos when configured with an existing page', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      await saveNotionPageMap(
        { [session.id]: { pageId: 'aa-bb-cc', status: 'ok' } },
        env,
        'linux',
      );
      const { stdout, messages } = capturingStdout();
      const bodies: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        bodies.push(String(init?.body ?? ''));
        expect(String(input)).toContain('/blocks/aa-bb-cc/children');
        return new Response('{}', { status: 200 });
      };
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: exportItems,
      });
      const acks = messages();
      expect(acks).toHaveLength(1);
      const ack = acks[0] as ExportActionsAck;
      expect(ack.ok).toBe(true);
      expect(ack.results).toEqual([
        { id: 'a1', ok: true },
        { id: 'a2', ok: true },
      ]);
      expect(ack.pageUrl).toBe('https://www.notion.so/aabbcc');
      expect(JSON.stringify(ack)).not.toContain('ntn_secret_value');
      expect(bodies).toHaveLength(1);
      const children = (JSON.parse(bodies[0]!) as { children: Array<{ type: string }> }).children;
      expect(children.map((c) => c.type)).toEqual(['heading_2', 'to_do', 'to_do']);
    });
  });

  it('sets ack.ok false when Notion returns 500 with per-item errors', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      await saveNotionPageMap(
        { [session.id]: { pageId: 'aa-bb-cc', status: 'ok' } },
        env,
        'linux',
      );
      const { stdout, messages } = capturingStdout();
      const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 });
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: exportItems,
      });
      const ack = messages()[0] as ExportActionsAck;
      expect(ack.ok).toBe(false);
      expect(ack.results).toHaveLength(2);
      expect(ack.results.every((r) => r.ok === false)).toBe(true);
      expect(ack.results[0]?.error).toMatch(/500/);
      expect(JSON.stringify(ack)).not.toContain('ntn_secret_value');
    });
  });

  it('rejects more than 200 items with a failed export ack', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      const { stdout, messages } = capturingStdout();
      let fetches = 0;
      const fetchImpl: typeof fetch = async () => {
        fetches += 1;
        return new Response('{}', { status: 200 });
      };
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      const many = Array.from({ length: 201 }, (_, i) => ({ id: `i${i}`, text: `t${i}` }));
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: many,
      });
      const ack = messages()[0] as ExportActionsAck;
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/200/);
      expect(ack.results).toEqual([]);
      expect(fetches).toBe(0);
    });
  });

  it('truncates oversized item text before building Notion blocks', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      await saveNotionPageMap(
        { [session.id]: { pageId: 'aa-bb-cc', status: 'ok' } },
        env,
        'linux',
      );
      const { stdout, messages } = capturingStdout();
      const bodies: string[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        bodies.push(String(init?.body ?? ''));
        return new Response('{}', { status: 200 });
      };
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: [
          {
            id: 'big',
            text: 'x'.repeat(10_000),
            owner: 'o'.repeat(500),
            due: 'd'.repeat(500),
          },
        ],
      });
      const ack = messages()[0] as ExportActionsAck;
      expect(ack.ok).toBe(true);
      expect(bodies).toHaveLength(1);
      const children = (
        JSON.parse(bodies[0]!) as {
          children: Array<{
            type: string;
            to_do?: { rich_text: Array<{ text: { content: string } }> };
          }>;
        }
      ).children;
      const todo = children.find((c) => c.type === 'to_do');
      const parts = todo?.to_do?.rich_text ?? [];
      expect(parts.length).toBeLessThanOrEqual(3);
      const combined = parts.map((p) => p.text.content).join('');
      expect(combined.length).toBeLessThanOrEqual(4000 + 200 + 200 + 6);
    });
  });

  it('tells the user to sync first when the session is unknown', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      const { stdout, messages } = capturingStdout();
      let fetches = 0;
      const fetchImpl: typeof fetch = async () => {
        fetches += 1;
        return new Response('{}', { status: 200 });
      };
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: exportItems,
      });
      const ack = messages()[0] as ExportActionsAck;
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/sync/i);
      expect(ack.results).toEqual([]);
      expect(fetches).toBe(0);
      expect(JSON.stringify(ack)).not.toContain('ntn_secret_value');
    });
  });

  it('does not disturb an in-flight sync', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        {
          obsidianEnabled: false,
          notionEnabled: true,
          notion: { token: 'ntn_secret_value', parentPageId: 'parent' },
        },
        env,
        'linux',
      );
      await saveNotionPageMap(
        { [session.id]: { pageId: 'page-1', status: 'ok' } },
        env,
        'linux',
      );
      const { stdout, messages } = capturingStdout();
      const fetchImpl: typeof fetch = async () => new Response('{}', { status: 200 });
      const host = new NativeSyncHost(stdout, env, { fetchImpl, platform: 'linux' });
      await host.handle({
        type: 'sync_begin',
        protocolVersion: 1,
        session,
        segments,
      });
      await host.handle({
        type: 'export_actions',
        protocolVersion: 1,
        sessionId: session.id,
        items: exportItems,
      });
      await host.handle({ type: 'sync_end', sessionId: session.id });
      const all = messages();
      const exportAcks = all.filter(isExportAck);
      const syncAcks = all.filter((m) => !isExportAck(m)) as HostSyncAck[];
      expect(exportAcks).toHaveLength(1);
      expect(exportAcks[0]?.ok).toBe(true);
      expect(exportAcks[0]?.results).toHaveLength(2);
      expect(syncAcks.length).toBeGreaterThanOrEqual(1);
      expect(syncAcks.every((a) => a.ok)).toBe(true);
      const meetings = join(home, 'ScribeTab', 'meetings');
      const dirs = (await readdir(meetings)).filter((n) => !n.startsWith('.'));
      expect(dirs).toHaveLength(1);
    });
  });
});
