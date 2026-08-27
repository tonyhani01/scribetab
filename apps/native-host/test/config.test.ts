import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getConfigValue,
  loadConfig,
  parseHostConfig,
  redactConfig,
  saveConfig,
  setConfigValue,
} from '../src/config.js';
import { configPath } from '../src/paths.js';
import { withHome } from './helpers.js';

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, '.local', 'share') };
}

describe('parseHostConfig', () => {
  it('defaults toggles off and ignores extra keys', () => {
    expect(parseHostConfig({})).toEqual({ obsidianEnabled: false, notionEnabled: false });
    expect(parseHostConfig({ extra: 1, obsidianEnabled: true })).toEqual({
      obsidianEnabled: true,
      notionEnabled: false,
    });
  });

  it('rejects non-objects and wrong types', () => {
    expect(() => parseHostConfig([])).toThrow(/JSON object/);
    expect(() => parseHostConfig({ obsidianEnabled: 'yes' })).toThrow(/boolean/);
    expect(() => parseHostConfig({ notion: 'x' })).toThrow(/object/);
  });
});

describe('set/get config values', () => {
  it('sets nested notion fields and unsets empty ones', () => {
    let cfg = setConfigValue({ obsidianEnabled: false, notionEnabled: false }, 'notion.token', 'ntn_secret');
    cfg = setConfigValue(cfg, 'notion.parentPageId', 'page-1');
    cfg = setConfigValue(cfg, 'obsidianEnabled', 'true');
    cfg = setConfigValue(cfg, 'obsidianVaultPath', '/Vault');
    expect(getConfigValue(cfg, 'notion.token')).toBe('ntn_secret');
    expect(getConfigValue(cfg, 'obsidianEnabled')).toBe('true');
    cfg = setConfigValue(cfg, 'notion.token', '');
    cfg = setConfigValue(cfg, 'notion.parentPageId', '');
    expect(cfg.notion).toBeUndefined();
  });

  it('redacts the token in dumps', () => {
    const redacted = redactConfig({
      obsidianEnabled: false,
      notionEnabled: true,
      notion: { token: 'ntn_secret', parentPageId: 'p' },
    });
    expect(redacted.notion?.token).toBe('***');
    expect(JSON.stringify(redacted)).not.toContain('ntn_secret');
  });
});

describe('load/save config', () => {
  it('returns defaults when the file is missing', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const cfg = await loadConfig(env, 'linux');
      expect(cfg).toEqual({ obsidianEnabled: false, notionEnabled: false });
    });
  });

  it('round-trips JSON to the per-OS user data dir', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const path = await saveConfig(
        {
          obsidianEnabled: true,
          obsidianVaultPath: '/tmp/vault',
          notionEnabled: false,
        },
        env,
        'linux',
      );
      expect(path).toBe(configPath('linux', env));
      expect(path).toBe(join(home, '.local', 'share', 'ScribeTab', 'config.json'));
      const loaded = await loadConfig(env, 'linux');
      expect(loaded.obsidianVaultPath).toBe('/tmp/vault');
      const mode = (await readFile(path).then(() => true)) && true;
      expect(mode).toBe(true);
    });
  });

  it('rejects invalid JSON', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const path = configPath('linux', env);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '{not json', 'utf8');
      await expect(loadConfig(env, 'linux')).rejects.toThrow(/Invalid host config JSON/);
    });
  });
});

describe('config file mode', () => {
  it('writes mode 0600 when the OS supports it', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const path = await saveConfig({ obsidianEnabled: false, notionEnabled: false }, env, 'linux');
      const { stat } = await import('node:fs/promises');
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
      await chmod(path, 0o600);
    });
  });
});
