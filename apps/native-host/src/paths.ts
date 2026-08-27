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

export function defaultHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}
