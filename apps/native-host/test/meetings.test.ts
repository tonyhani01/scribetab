import { mkdir, symlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLatestMeeting, listMeetings } from '../src/meetings.js';
import { withHome } from './helpers.js';

async function writeMeeting(
  root: string,
  dir: string,
  startedAt: string | undefined,
  title: string,
): Promise<void> {
  const path = join(root, dir);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'transcript.json'),
    JSON.stringify({
      session: startedAt
        ? { id: dir, title, startedAt, platform: 'other', status: 'complete' }
        : { id: dir, title, platform: 'other', status: 'complete' },
      segments: [],
    }),
    'utf8',
  );
  await writeFile(join(path, 'transcript.md'), `# ${title}\n`, 'utf8');
}

describe('listMeetings', () => {
  it('sorts by startedAt then mtime, and skips symlinked dirs', async () => {
    await withHome(async (home) => {
      const root = join(home, 'meetings');
      await writeMeeting(root, 'old', '2026-01-01T00:00:00.000Z', 'Old');
      await writeMeeting(root, 'new', '2026-08-01T00:00:00.000Z', 'New');
      await writeMeeting(root, 'undated', undefined, 'Undated');
      await utimes(join(root, 'undated'), new Date('2026-09-01'), new Date('2026-09-01'));
      await mkdir(join(home, 'outside'), { recursive: true });
      await symlink(join(home, 'outside'), join(root, 'escape'));

      const listed = await listMeetings(root);
      expect(listed.map((m) => m.dirName)).toEqual(['new', 'old', 'undated']);
      expect(await getLatestMeeting(root)).toMatchObject({ dirName: 'new' });
    });
  });
});
