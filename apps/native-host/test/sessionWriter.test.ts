import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeWav, type MeetingSession, type TranscriptSegment } from '@scribetab/shared';
import {
  abortSync,
  appendAudioChunk,
  beginSync,
  commitSync,
  sweepOrphanTmpDirs,
} from '../src/sessionWriter.js';
import { withHome } from './helpers.js';

const session: MeetingSession = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Atomic Test',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'meet',
  status: 'complete',
};

const segments: TranscriptSegment[] = [
  {
    id: 's1',
    sessionId: session.id,
    startMs: 0,
    endMs: 1000,
    text: 'hello',
    source: 'audio',
  },
];

describe('sessionWriter atomic rename', () => {
  it('does not expose a meeting dir until commit, then writes the layout', async () => {
    await withHome(async (home) => {
      const meetings = join(home, 'ScribeTab', 'meetings');
      const sync = await beginSync(meetings, session, segments, {
        summaryMarkdown: '# Summary\n',
        audio: { format: 'wav', sampleRate: 16000, totalChunks: 1 },
      });
      expect(sync.tmpDir.includes('.tmp-')).toBe(true);
      expect(existsSync(join(meetings, '2026-08-27-atomic-test'))).toBe(false);

      const wav = encodeWav(new Float32Array([0, 0.1, -0.1]), 16000);
      await appendAudioChunk(sync, 0, Buffer.from(wav).toString('base64'));
      const dest = await commitSync(sync, meetings);

      expect(dest).toBe(join(meetings, '2026-08-27-atomic-test'));
      expect(existsSync(join(dest, 'transcript.md'))).toBe(true);
      expect(existsSync(join(dest, 'transcript.json'))).toBe(true);
      expect(existsSync(join(dest, 'summary.md'))).toBe(true);
      expect(existsSync(join(dest, 'audio.wav'))).toBe(true);
      expect(existsSync(sync.tmpDir)).toBe(false);
    });
  });

  it('suffixes -2 on collision and abort removes the temp dir', async () => {
    await withHome(async (home) => {
      const meetings = join(home, 'ScribeTab', 'meetings');
      await mkdir(join(meetings, '2026-08-27-atomic-test'), { recursive: true });
      const sync = await beginSync(meetings, session, segments);
      const dest = await commitSync(sync, meetings);
      expect(dest.endsWith('2026-08-27-atomic-test-2')).toBe(true);

      const abandoned = await beginSync(meetings, session, segments);
      await abortSync(abandoned);
      expect(existsSync(abandoned.tmpDir)).toBe(false);
    });
  });

  it('overwrites the same sessionId dir instead of creating -2',
    async () => {
      await withHome(async (home) => {
        const meetings = join(home, 'ScribeTab', 'meetings');
        const first = await beginSync(meetings, session, segments);
        const dest = await commitSync(first, meetings);
        const updated = { ...session, title: 'Atomic Test Reloaded' };
        const second = await beginSync(meetings, updated, segments);
        const dest2 = await commitSync(second, meetings);
        expect(dest2).toBe(dest);
        const dirs = (await readdir(meetings)).filter((n) => !n.startsWith('.'));
        expect(dirs).toEqual(['2026-08-27-atomic-test']);
        const json = JSON.parse(await readFile(join(dest2, 'transcript.json'), 'utf8')) as {
          session: MeetingSession;
        };
        expect(json.session.title).toBe('Atomic Test Reloaded');
      });
    },
  );

  it('sweeps orphaned .tmp-* dirs',
    async () => {
      await withHome(async (home) => {
        const meetings = join(home, 'ScribeTab', 'meetings');
        await mkdir(join(meetings, '.tmp-orphan'), { recursive: true });
        await writeFile(join(meetings, '.tmp-orphan', 'x'), 'y');
        await sweepOrphanTmpDirs(meetings);
        expect(existsSync(join(meetings, '.tmp-orphan'))).toBe(false);
      });
    },
  );

  it('skips audio larger than 8 MiB and still writes the transcript',
    async () => {
      await withHome(async (home) => {
        const meetings = join(home, 'ScribeTab', 'meetings');
        const sync = await beginSync(meetings, session, segments, {
          audio: { format: 'wav', sampleRate: 16000, totalChunks: 1 },
        });
        const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
        await appendAudioChunk(sync, 0, huge.toString('base64'));
        expect(sync.audioSkipped).toMatch(/exceeds 8 MiB/);
        const dest = await commitSync(sync, meetings);
        expect(existsSync(join(dest, 'transcript.md'))).toBe(true);
        expect(existsSync(join(dest, 'audio.wav'))).toBe(false);
      });
    },
  );

  it('writes ogg-opus bytes verbatim to audio.ogg with no wav file', async () => {
    await withHome(async (home) => {
      const meetings = join(home, 'ScribeTab', 'meetings');
      const a = Buffer.from('RIFF____not-actually-wav');
      const b = Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
      const sync = await beginSync(meetings, session, segments, {
        audio: { format: 'ogg-opus', totalChunks: 2 },
      });
      expect(existsSync(join(sync.tmpDir, 'audio.wav'))).toBe(false);
      await appendAudioChunk(sync, 0, a.toString('base64'));
      await appendAudioChunk(sync, 1, b.toString('base64'));
      const dest = await commitSync(sync, meetings);
      expect(existsSync(join(dest, 'audio.ogg'))).toBe(true);
      expect(existsSync(join(dest, 'audio.wav'))).toBe(false);
      expect(await readFile(join(dest, 'audio.ogg'))).toEqual(Buffer.concat([a, b]));
    });
  });
});
