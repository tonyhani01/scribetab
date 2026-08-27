import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { HostSyncAck, MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { saveConfig } from '../src/config.js';
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
  function acks(): HostSyncAck[] {
    const buf = Buffer.concat(bufs);
    const out: HostSyncAck[] = [];
    let i = 0;
    while (i + 4 <= buf.length) {
      const len = buf.readUInt32LE(i);
      i += 4;
      if (i + len > buf.length) break;
      out.push(JSON.parse(buf.subarray(i, i + len).toString('utf8')) as HostSyncAck);
      i += len;
    }
    return out;
  }
  return { stdout, acks };
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
