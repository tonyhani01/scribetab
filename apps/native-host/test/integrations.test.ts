import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { saveConfig } from '../src/config.js';
import { runPostSyncIntegrations } from '../src/integrations.js';
import { withHome } from './helpers.js';

const session: MeetingSession = {
  id: 'int-1',
  title: 'Integrations',
  startedAt: '2026-08-27T10:00:00.000Z',
  platform: 'other',
  status: 'complete',
};
const segments: TranscriptSegment[] = [
  {
    id: 's',
    sessionId: session.id,
    startMs: 0,
    endMs: 1,
    text: 'hi',
    source: 'audio',
  },
];

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, '.local', 'share') };
}

describe('runPostSyncIntegrations', () => {
  it('is a no-op when toggles are off', async () => {
    await withHome(async (home) => {
      const errors = await runPostSyncIntegrations({
        session,
        segments,
        env: linuxEnv(home),
        platform: 'linux',
      });
      expect(errors).toEqual([]);
    });
  });

  it('copies to Obsidian and reports Notion errors without throwing', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const vault = join(home, 'vault');
      await mkdir(vault, { recursive: true });
      await saveConfig(
        {
          obsidianEnabled: true,
          obsidianVaultPath: vault,
          notionEnabled: true,
          notion: { token: 't', parentPageId: 'p' },
        },
        env,
        'linux',
      );
      const errors = await runPostSyncIntegrations({
        session,
        segments,
        summaryMarkdown: 'done',
        env,
        platform: 'linux',
        fetchImpl: async () => new Response('nope', { status: 401 }),
      });
      const md = await readFile(join(vault, 'ScribeTab', '2026-08-27-integrations.md'), 'utf8');
      expect(md).toContain('hi');
      expect(errors.some((e) => e.includes('401'))).toBe(true);
    });
  });

  it('reports a missing vault without throwing', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      await saveConfig(
        { obsidianEnabled: true, obsidianVaultPath: join(home, 'missing'), notionEnabled: false },
        env,
        'linux',
      );
      const errors = await runPostSyncIntegrations({
        session,
        segments,
        env,
        platform: 'linux',
      });
      expect(errors.join(' ')).toMatch(/does not exist/);
    });
  });

  it('surfaces invalid config JSON', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const path = join(home, '.local', 'share', 'ScribeTab', 'config.json');
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '{', 'utf8');
      const errors = await runPostSyncIntegrations({
        session,
        segments,
        env,
        platform: 'linux',
      });
      expect(errors.join(' ')).toMatch(/Invalid host config/);
    });
  });
});
