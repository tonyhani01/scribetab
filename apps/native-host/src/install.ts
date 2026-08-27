import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_EXTENSION_ID, HOST_NAME } from './constants.js';
import { homeDir, scribetabRoot } from './paths.js';

export interface InstallOptions {
  extensionId?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostScript?: string;
  nodePath?: string;
  writeRegistry?: (key: string, value: string) => void;
}

export function chromeNativeMessagingDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = homeDir(env);
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  if (platform === 'win32') {
    return join(scribetabRoot(env), 'NativeMessagingHosts');
  }
  return join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
}

export function windowsRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
}

function launcherPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const bin = join(scribetabRoot(env), 'bin');
  return platform === 'win32' ? join(bin, 'scribetab-host.cmd') : join(bin, 'scribetab-host');
}

function unixLauncher(nodePath: string, hostScript: string): string {
  return `#!/bin/sh\nexec "${nodePath}" "${hostScript}" "$@"\n`;
}

function winLauncher(nodePath: string, hostScript: string): string {
  return `@echo off\r\n"${nodePath}" "${hostScript}" %*\r\n`;
}

export function nativeHostManifest(opts: {
  path: string;
  extensionId: string;
}): { name: string; description: string; path: string; type: 'stdio'; allowed_origins: string[] } {
  return {
    name: HOST_NAME,
    description: 'ScribeTab native messaging host',
    path: opts.path,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${opts.extensionId}/`],
  };
}

function defaultRegistryWriter(key: string, value: string): void {
  const r = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`Failed to write Windows registry key ${key}: ${r.stderr || r.stdout || r.status}`);
  }
}

export async function installNativeHost(opts: InstallOptions = {}): Promise<{
  manifestPath: string;
  launcherPath: string;
  extensionId: string;
}> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const extensionId = opts.extensionId || DEFAULT_EXTENSION_ID;
  const hostScript = opts.hostScript;
  const nodePath = opts.nodePath ?? process.execPath;
  if (!hostScript) throw new Error('hostScript path is required');

  const launch = launcherPath(env, platform);
  await mkdir(dirname(launch), { recursive: true });
  if (platform === 'win32') {
    await writeFile(launch, winLauncher(nodePath, hostScript), 'utf8');
  } else {
    await writeFile(launch, unixLauncher(nodePath, hostScript), 'utf8');
    await chmod(launch, 0o755);
  }

  const dir = chromeNativeMessagingDir(platform, env);
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, `${HOST_NAME}.json`);
  const manifest = nativeHostManifest({ path: launch, extensionId });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (platform === 'win32') {
    const write = opts.writeRegistry ?? defaultRegistryWriter;
    write(windowsRegistryKey(), manifestPath);
  }

  return { manifestPath, launcherPath: launch, extensionId };
}

export async function uninstallNativeHost(opts: InstallOptions = {}): Promise<{
  manifestPath: string;
  launcherPath: string;
}> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const manifestPath = join(chromeNativeMessagingDir(platform, env), `${HOST_NAME}.json`);
  const launch = launcherPath(env, platform);
  await unlink(manifestPath).catch(() => {});
  await unlink(launch).catch(() => {});
  if (platform === 'win32') {
    spawnSync('reg', ['delete', windowsRegistryKey(), '/f'], { encoding: 'utf8' });
  }
  return { manifestPath, launcherPath: launch };
}
