import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeWav, type HostSyncAck, type MeetingSession, type TranscriptSegment } from '@scribetab/shared';
import { readNativeMessage, rmrf, sendNative, spawnHost, tempHome } from './helpers.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const session: MeetingSession = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: 'Protocol Sync',
  startedAt: '2026-08-27T12:00:00.000Z',
  endedAt: '2026-08-27T12:30:00.000Z',
  platform: 'youtube',
  tabUrl: 'https://www.youtube.com/watch?v=dQw4w9wgGcQ',
  status: 'complete',
};

const segments: TranscriptSegment[] = [
  {
    id: 'seg-1',
    sessionId: session.id,
    startMs: 0,
    endMs: 1500,
    text: 'welcome everyone',
    source: 'audio',
  },
];

let child: ChildProcessWithoutNullStreams | undefined;
let home: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((r) => child!.once('exit', r));
  }
  child = undefined;
  if (home) await rmrf(home);
  home = undefined;
});

describe('native messaging protocol (child process)', () => {
  it('begin → chunk → end writes the meeting and acks', async () => {
    home = await tempHome();
    child = spawnHost(home);
    const wav = encodeWav(new Float32Array(32), 16000);
    sendNative(child, {
      type: 'sync_begin',
      protocolVersion: 1,
      session,
      segments,
      summaryMarkdown: 'action items: none\n',
      audio: { format: 'wav', sampleRate: 16000, totalChunks: 1 },
    });
    sendNative(child, {
      type: 'sync_audio_chunk',
      sessionId: session.id,
      index: 0,
      wavBase64: Buffer.from(wav).toString('base64'),
    });
    sendNative(child, { type: 'sync_end', sessionId: session.id });

    const ack = (await readNativeMessage(child)) as HostSyncAck;
    expect(ack).toEqual({ ok: true, sessionId: session.id });

    const dir = join(home, 'ScribeTab', 'meetings', '2026-08-27-protocol-sync');
    expect(existsSync(join(dir, 'transcript.md'))).toBe(true);
    expect(existsSync(join(dir, 'transcript.json'))).toBe(true);
    expect(existsSync(join(dir, 'summary.md'))).toBe(true);
    expect(existsSync(join(dir, 'audio.wav'))).toBe(true);
    const md = await readFile(join(dir, 'transcript.md'), 'utf8');
    expect(md).toContain('welcome everyone');
    const json = JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8')) as {
      session: MeetingSession;
    };
    expect(json.session.id).toBe(session.id);

    child.stdin.end();
    await new Promise((r) => child!.once('exit', r));
    child = undefined;
  });

  it('replies a failure ack when sync_end arrives without begin', async () => {
    home = await tempHome();
    child = spawnHost(home);
    sendNative(child, { type: 'sync_end', sessionId: 'nope' });
    const ack = (await readNativeMessage(child)) as HostSyncAck;
    expect(ack.ok).toBe(false);
    expect(ack.sessionId).toBe('nope');
    expect(ack.error).toMatch(/without sync_begin/);
    expect(existsSync(join(home, 'ScribeTab', 'meetings'))).toBe(false);

    child.stdin.end();
    await new Promise((r) => child!.once('exit', r));
    child = undefined;
  });

  it('re-syncs the same sessionId into one directory', { timeout: 15_000 }, async () => {
    home = await tempHome();
    child = spawnHost(home);
    const payload = {
      type: 'sync_begin' as const,
      protocolVersion: 1 as const,
      session,
      segments,
    };
    sendNative(child, payload);
    sendNative(child, { type: 'sync_end', sessionId: session.id });
    expect((await readNativeMessage(child) as HostSyncAck).ok).toBe(true);
    expect((await readNativeMessage(child) as HostSyncAck).ok).toBe(true);

    sendNative(child, {
      ...payload,
      session: { ...session, title: 'Protocol Sync Again' },
    });
    sendNative(child, { type: 'sync_end', sessionId: session.id });
    expect((await readNativeMessage(child) as HostSyncAck).ok).toBe(true);
    expect((await readNativeMessage(child) as HostSyncAck).ok).toBe(true);

    const root = join(home, 'ScribeTab', 'meetings');
    const { readdir } = await import('node:fs/promises');
    const dirs = (await readdir(root)).filter((n) => !n.startsWith('.'));
    expect(dirs).toEqual(['2026-08-27-protocol-sync']);
    const json = JSON.parse(
      await readFile(join(root, dirs[0]!, 'transcript.json'), 'utf8'),
    ) as { session: MeetingSession };
    expect(json.session.title).toBe('Protocol Sync Again');

    child.stdin.end();
    await new Promise((r) => child!.once('exit', r));
    child = undefined;
  });

  it('protocol v2 writes audio.ogg verbatim', async () => {
    home = await tempHome();
    child = spawnHost(home);
    const payload = Buffer.from('OggS-not-a-real-page-but-verbatim');
    sendNative(child, {
      type: 'sync_begin',
      protocolVersion: 2,
      session,
      segments,
      audio: { format: 'ogg-opus', totalChunks: 1 },
    });
    sendNative(child, {
      type: 'sync_audio_chunk',
      sessionId: session.id,
      index: 0,
      dataBase64: payload.toString('base64'),
    });
    sendNative(child, { type: 'sync_end', sessionId: session.id });

    const ack = (await readNativeMessage(child)) as HostSyncAck;
    expect(ack).toEqual({ ok: true, sessionId: session.id });

    const dir = join(home, 'ScribeTab', 'meetings', '2026-08-27-protocol-sync');
    expect(existsSync(join(dir, 'audio.ogg'))).toBe(true);
    expect(existsSync(join(dir, 'audio.wav'))).toBe(false);
    expect(await readFile(join(dir, 'audio.ogg'))).toEqual(payload);

    child.stdin.end();
    await new Promise((r) => child!.once('exit', r));
    child = undefined;
  });
});
