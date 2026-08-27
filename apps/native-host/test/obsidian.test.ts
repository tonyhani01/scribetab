import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { copyToObsidian, sessionIdFromMarkdown } from '../src/obsidian.js';
import { withHome } from './helpers.js';

const session: MeetingSession = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Vault Meeting',
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
    text: 'hello vault',
    speaker: 'Ada',
    source: 'audio',
  },
];

describe('copyToObsidian', () => {
  it('writes ScribeTab/<date>-<slug>.md with summary and sessionId frontmatter', async () => {
    await withHome(async (home) => {
      const vault = join(home, 'vault');
      await mkdir(vault, { recursive: true });
      const dest = await copyToObsidian({
        vaultPath: vault,
        session,
        segments,
        summaryMarkdown: '## Recap\n\nShipped.',
      });
      expect(dest).toBe(join(vault, 'ScribeTab', '2026-08-27-vault-meeting.md'));
      const text = await readFile(dest, 'utf8');
      expect(sessionIdFromMarkdown(text)).toBe(session.id);
      expect(text).toContain('# Vault Meeting');
      expect(text).toContain('hello vault');
      expect(text).toContain('Shipped.');
    });
  });

  it('overwrites the same sessionId path on re-sync even if the title changes', async () => {
    await withHome(async (home) => {
      const vault = join(home, 'vault');
      await mkdir(vault, { recursive: true });
      const first = await copyToObsidian({ vaultPath: vault, session, segments });
      const second = await copyToObsidian({
        vaultPath: vault,
        session: { ...session, title: 'Renamed Meeting' },
        segments: [{ ...segments[0]!, text: 'updated' }],
      });
      expect(second).toBe(first);
      const text = await readFile(first, 'utf8');
      expect(text).toContain('updated');
      expect(text).toContain('# Renamed Meeting');
      expect(existsSync(join(vault, 'ScribeTab', '2026-08-27-renamed-meeting.md'))).toBe(false);
    });
  });

  it('suffixes -2 when the slug file belongs to a different session', async () => {
    await withHome(async (home) => {
      const vault = join(home, 'vault');
      const dir = join(vault, 'ScribeTab');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '2026-08-27-vault-meeting.md'), '---\nsessionId: other\n---\n', 'utf8');
      const dest = await copyToObsidian({ vaultPath: vault, session, segments });
      expect(dest.endsWith('2026-08-27-vault-meeting-2.md')).toBe(true);
    });
  });

  it('errors when the vault path is missing or not a directory', async () => {
    await withHome(async (home) => {
      await expect(
        copyToObsidian({ vaultPath: join(home, 'nope'), session, segments }),
      ).rejects.toThrow(/does not exist/);
      const file = join(home, 'not-a-dir');
      await writeFile(file, 'x');
      await expect(copyToObsidian({ vaultPath: file, session, segments })).rejects.toThrow(
        /not a directory/,
      );
    });
  });

  it('treats a dangling symlink as taken and suffixes -2', async () => {
    await withHome(async (home) => {
      const vault = join(home, 'vault');
      const dir = join(vault, 'ScribeTab');
      await mkdir(dir, { recursive: true });
      await symlink(join(dir, 'missing-target.md'), join(dir, '2026-08-27-vault-meeting.md'));
      const dest = await copyToObsidian({ vaultPath: vault, session, segments });
      expect(dest.endsWith('2026-08-27-vault-meeting-2.md')).toBe(true);
    });
  });

  it('refuses to write when ScribeTab is a symlink', async () => {
    await withHome(async (home) => {
      const vault = join(home, 'vault');
      await mkdir(vault, { recursive: true });
      await mkdir(join(home, 'other'), { recursive: true });
      await symlink(join(home, 'other'), join(vault, 'ScribeTab'));
      await expect(copyToObsidian({ vaultPath: vault, session, segments })).rejects.toThrow(/symlink/);
    });
  });

  it('overwrites atomically without leaving tmp files', async () => {
    await withHome(async (home) => {
      const vault = join(home, 'vault');
      await mkdir(vault, { recursive: true });
      const dest = await copyToObsidian({ vaultPath: vault, session, segments });
      await copyToObsidian({
        vaultPath: vault,
        session,
        segments: [{ ...segments[0]!, text: 'replaced' }],
      });
      const text = await readFile(dest, 'utf8');
      expect(text).toContain('replaced');
      const names = await readdir(join(vault, 'ScribeTab'));
      expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
    });
  });
});
