import { homedir } from 'node:os';
import { join } from 'node:path';

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error('HOME (or USERPROFILE) is not set');
  return home;
}

export function scribetabRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), 'ScribeTab');
}

export function meetingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(scribetabRoot(env), 'meetings');
}

/** Per-user data dir (host binary + config.json). Distinct from ~/ScribeTab/meetings. */
export function userDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = homeDir(env);
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ScribeTab');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'ScribeTab');
  }
  const xdg = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(xdg, 'ScribeTab');
}

export function configPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(userDataDir(platform, env), 'config.json');
}

export function notionPagesPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(userDataDir(platform, env), 'notion-pages.json');
}

export function defaultHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}
