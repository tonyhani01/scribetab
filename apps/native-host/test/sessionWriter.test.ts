import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeWav, type MeetingSession, type TranscriptSegment } from '@scribetab/shared';
import {
  abortSync,
  appendAudioChunk,
  beginSync,
  commitSync,
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
});
