import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configPath } from './paths.js';

export interface NotionConfig {
  token: string;
  parentPageId: string;
}

export interface HostConfig {
  obsidianEnabled: boolean;
  obsidianVaultPath?: string;
  notionEnabled: boolean;
  notion?: NotionConfig;
}

export const DEFAULT_HOST_CONFIG: HostConfig = {
  obsidianEnabled: false,
  notionEnabled: false,
};

export const CONFIG_KEYS = [
  'obsidianEnabled',
  'obsidianVaultPath',
  'notionEnabled',
  'notion.token',
  'notion.parentPageId',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(s: string): s is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(s);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asBool(v: unknown, field: string): boolean {
  if (typeof v === 'boolean') return v;
  throw new Error(`Host config ${field} must be a boolean`);
}

function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Host config ${field} must be a string`);
  const t = v.trim();
  return t ? t : undefined;
}

export function parseHostConfig(raw: unknown): HostConfig {
  if (!isRecord(raw)) throw new Error('Host config must be a JSON object');
  const cfg: HostConfig = {
    obsidianEnabled: raw.obsidianEnabled === undefined ? false : asBool(raw.obsidianEnabled, 'obsidianEnabled'),
    notionEnabled: raw.notionEnabled === undefined ? false : asBool(raw.notionEnabled, 'notionEnabled'),
  };
  const vault = asOptionalString(raw.obsidianVaultPath, 'obsidianVaultPath');
  if (vault) cfg.obsidianVaultPath = vault;
  if (raw.notion !== undefined) {
    if (!isRecord(raw.notion)) throw new Error('Host config notion must be an object');
    const token = asOptionalString(raw.notion.token, 'notion.token') ?? '';
    const parentPageId = asOptionalString(raw.notion.parentPageId, 'notion.parentPageId') ?? '';
    if (token || parentPageId) cfg.notion = { token, parentPageId };
  }
  return cfg;
}

export function redactConfig(cfg: HostConfig): HostConfig {
  if (!cfg.notion?.token) return cfg;
  return { ...cfg, notion: { ...cfg.notion, token: '***' } };
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<HostConfig> {
  const path = configPath(platform, env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ...DEFAULT_HOST_CONFIG };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid host config JSON at ${path}`);
  }
  return parseHostConfig(parsed);
}

export async function saveConfig(
  cfg: HostConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const path = configPath(platform, env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.config-${randomUUID()}.tmp`);
  const body = JSON.stringify(cfg, null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
  return path;
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  throw new Error(`Expected boolean for this key (true/false), got ${JSON.stringify(value)}`);
}

export function getConfigValue(cfg: HostConfig, key: ConfigKey): string {
  switch (key) {
    case 'obsidianEnabled':
      return String(cfg.obsidianEnabled);
    case 'obsidianVaultPath':
      return cfg.obsidianVaultPath ?? '';
    case 'notionEnabled':
      return String(cfg.notionEnabled);
    case 'notion.token':
      return cfg.notion?.token ?? '';
    case 'notion.parentPageId':
      return cfg.notion?.parentPageId ?? '';
  }
}

export function setConfigValue(cfg: HostConfig, key: ConfigKey, value: string): HostConfig {
  const next: HostConfig = {
    obsidianEnabled: cfg.obsidianEnabled,
    notionEnabled: cfg.notionEnabled,
  };
  if (cfg.obsidianVaultPath) next.obsidianVaultPath = cfg.obsidianVaultPath;
  if (cfg.notion) next.notion = { ...cfg.notion };

  const unset = value.trim() === '';

  switch (key) {
    case 'obsidianEnabled':
      next.obsidianEnabled = parseBool(value);
      break;
    case 'obsidianVaultPath':
      if (unset) delete next.obsidianVaultPath;
      else next.obsidianVaultPath = value.trim();
      break;
    case 'notionEnabled':
      next.notionEnabled = parseBool(value);
      break;
    case 'notion.token': {
      const notion = next.notion ?? { token: '', parentPageId: '' };
      notion.token = unset ? '' : value.trim();
      next.notion = notion;
      break;
    }
    case 'notion.parentPageId': {
      const notion = next.notion ?? { token: '', parentPageId: '' };
      notion.parentPageId = unset ? '' : value.trim();
      next.notion = notion;
      break;
    }
  }

  if (next.notion && !next.notion.token && !next.notion.parentPageId) {
    delete next.notion;
  }
  return next;
}

export function configPathHelp(): string {
  return [
    'macOS:   ~/Library/Application Support/ScribeTab/config.json',
    'Linux:   $XDG_DATA_HOME/ScribeTab/config.json  (default ~/.local/share/ScribeTab/config.json)',
    'Windows: %APPDATA%\\ScribeTab\\config.json',
  ].join('\n');
}
