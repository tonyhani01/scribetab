import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConfigCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';
import { HOST_JS, HOST_LEGACY_JS, MCP_JS, withHome } from './helpers.js';

const execFileAsync = promisify(execFile);

describe('CLI --help', () => {
  it('runs under plain Node', async () => {
    const { stdout } = await execFileAsync(process.execPath, [HOST_JS, '--help']);
    expect(stdout).toMatch(/scribetab-host/);
    expect(stdout).toMatch(/install/);
  });

  it('mcp --help runs under plain Node', async () => {
    const { stdout } = await execFileAsync(process.execPath, [MCP_JS, '--help']);
    expect(stdout).toMatch(/scribetab-mcp/);
    expect(stdout).toMatch(/list_transcripts/);
  });

  it('bin entrypoints start', async () => {
    const host = await execFileAsync(process.execPath, [HOST_JS, '--help']);
    expect(host.stdout).toMatch(/scribetab-host/);
    const mcp = await execFileAsync(process.execPath, [MCP_JS, '--help']);
    expect(mcp.stdout).toMatch(/scribetab-mcp/);
    const legacy = await execFileAsync(process.execPath, [HOST_LEGACY_JS, '--help']);
    expect(legacy.stdout).toMatch(/scribetab-host/);
  });

  it('mentions config get/set', async () => {
    const { stdout } = await execFileAsync(process.execPath, [HOST_JS, '--help']);
    expect(stdout).toMatch(/config get/);
    expect(stdout).toMatch(/obsidianVaultPath/);
  });
});

describe('CLI config', () => {
  it('sets and gets keys under the user data dir', async () => {
    await withHome(async (home) => {
      const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') };
      const exec = (args: string[]) => execFileAsync(process.execPath, [HOST_JS, ...args], { env });
      const set = await exec(['config', 'set', 'obsidianEnabled', 'true']);
      expect(set.stdout).toMatch(/Wrote /);
      const get = await exec(['config', 'get', 'obsidianEnabled']);
      expect(get.stdout.trim()).toBe('true');
      await exec(['config', 'set', 'notion.token', 'ntn_secret']);
      const dump = await exec(['config', 'get']);
      expect(dump.stdout).toContain('***');
      expect(dump.stdout).not.toContain('ntn_secret');
      const path = configPath(process.platform, env);
      const onDisk = await readFile(path, 'utf8');
      expect(onDisk).toContain('ntn_secret');
    });
  });

  it('keeps values starting with - and rejects extra args', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const io = captureIo();
      await runConfigCli(['set', 'obsidianVaultPath', '/tmp/vault-name'], io, env, 'linux');
      await runConfigCli(['set', 'obsidianVaultPath', '/tmp/-weird'], io, env, 'linux');
      const cfg = await loadConfig(env, 'linux');
      expect(cfg.obsidianVaultPath).toBe('/tmp/-weird');
      await expect(runConfigCli(['set', 'obsidianVaultPath', '/a', '/b'], io, env, 'linux')).rejects.toThrow(
        /single value/,
      );
      await runConfigCli(['set', 'obsidianVaultPath', '/tmp/hello  world'], io, env, 'linux');
      expect((await loadConfig(env, 'linux')).obsidianVaultPath).toBe('/tmp/hello  world');
    });
  });

  it('reads notion.token from stdin when the value is -', async () => {
    await withHome(async (home) => {
      const env = linuxEnv(home);
      const io = captureIo(Readable.from(['ntn_from_stdin\n']));
      await runConfigCli(['set', 'notion.token', '-'], io, env, 'linux');
      const cfg = await loadConfig(env, 'linux');
      expect(cfg.notion?.token).toBe('ntn_from_stdin');
    });
  });
});

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, '.local', 'share') };
}

function captureIo(stdin?: Readable) {
  const chunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk as Buffer));
      cb();
    },
  });
  return { stdout, stderr: stdout, stdin, chunks };
}
