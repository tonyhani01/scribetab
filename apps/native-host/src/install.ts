import { chmod, cp, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_EXTENSION_IDS, HOST_NAME } from './constants.js';
import { homeDir } from './paths.js';

export const EXTENSION_ID_RE = /^[a-p]{32}$/;

export function validateExtensionId(id: string): void {
  if (!EXTENSION_ID_RE.test(id)) {
    throw new Error(`Invalid extension id (expected 32 chars a-p): ${id.slice(0, 32)}`);
  }
}

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
    return join(stableHostDir(platform, env), 'NativeMessagingHosts');
  }
  return join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
}

export function stableHostDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = homeDir(env);
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ScribeTab', 'host');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'ScribeTab', 'host');
  }
  const xdg = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(xdg, 'ScribeTab', 'host');
}

export function windowsRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
}

function launcherPath(platform: NodeJS.Platform, destRoot: string): string {
  return platform === 'win32' ? join(destRoot, 'scribetab-host.cmd') : join(destRoot, 'scribetab-host');
}

function unixLauncher(nodePath: string, hostScript: string): string {
  return `#!/bin/sh\nexec "${nodePath}" "${hostScript}" "$@"\n`;
}

function winLauncher(nodePath: string, hostScript: string): string {
  return `@echo off\r\n"${nodePath}" "${hostScript}" %*\r\n`;
}

export function nativeHostManifest(opts: {
  path: string;
  extensionIds: string[];
}): { name: string; description: string; path: string; type: 'stdio'; allowed_origins: string[] } {
  return {
    name: HOST_NAME,
    description: 'ScribeTab native messaging host',
    path: opts.path,
    type: 'stdio',
    allowed_origins: opts.extensionIds.map((id) => `chrome-extension://${id}/`),
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

async function copyHostToStable(hostScript: string, destRoot: string): Promise<string> {
  const destDist = join(destRoot, 'dist');
  await mkdir(destDist, { recursive: true });
  try {
    await lstat(hostScript);
  } catch {
    return hostScript;
  }
  const distDir = dirname(hostScript);
  try {
    const entries = await readdir(distDir);
    for (const name of entries) {
      await cp(join(distDir, name), join(destDist, name), { recursive: true, dereference: true });
    }
  } catch {
    await cp(hostScript, join(destDist, basename(hostScript))).catch(() => {});
  }
  const pkgRoot = join(distDir, '..');
  try {
    await lstat(join(pkgRoot, 'node_modules'));
    await cp(join(pkgRoot, 'node_modules'), join(destRoot, 'node_modules'), {
      recursive: true,
      dereference: true,
    });
  } catch {
    // npx package without a copyable node_modules — launcher still points at copied dist
  }
  try {
    await cp(join(pkgRoot, 'package.json'), join(destRoot, 'package.json'));
  } catch {
    // optional
  }
  return join(destDist, basename(hostScript));
}

export async function installNativeHost(opts: InstallOptions = {}): Promise<{
  manifestPath: string;
  launcherPath: string;
  extensionIds: string[];
  hostScript: string;
}> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const extensionIds = opts.extensionId ? [opts.extensionId] : DEFAULT_EXTENSION_IDS;
  for (const id of extensionIds) validateExtensionId(id);
  const hostScript = opts.hostScript;
  const nodePath = opts.nodePath ?? process.execPath;
  if (!hostScript) throw new Error('hostScript path is required');

  const destRoot = stableHostDir(platform, env);
  await mkdir(destRoot, { recursive: true });
  const copied = await copyHostToStable(hostScript, destRoot);

  const launch = launcherPath(platform, destRoot);
  if (platform === 'win32') {
    await writeFile(launch, winLauncher(nodePath, copied), 'utf8');
  } else {
    await writeFile(launch, unixLauncher(nodePath, copied), 'utf8');
    await chmod(launch, 0o755);
  }

  const dir = chromeNativeMessagingDir(platform, env);
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, `${HOST_NAME}.json`);
  const manifest = nativeHostManifest({ path: launch, extensionIds });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (platform === 'win32') {
    const write = opts.writeRegistry ?? defaultRegistryWriter;
    write(windowsRegistryKey(), manifestPath);
  }

  return { manifestPath, launcherPath: launch, extensionIds, hostScript: copied };
}

export async function uninstallNativeHost(opts: InstallOptions = {}): Promise<{
  manifestPath: string;
  launcherPath: string;
}> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const destRoot = stableHostDir(platform, env);
  const manifestPath = join(chromeNativeMessagingDir(platform, env), `${HOST_NAME}.json`);
  const launch = launcherPath(platform, destRoot);
  await unlink(manifestPath).catch(() => {});
  await unlink(launch).catch(() => {});
  if (platform === 'win32') {
    spawnSync('reg', ['delete', windowsRegistryKey(), '/f'], { encoding: 'utf8' });
  }
  return { manifestPath, launcherPath: launch };
}
