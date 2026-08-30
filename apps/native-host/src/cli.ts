import { fileURLToPath } from 'node:url';
import { DEFAULT_EXTENSION_ID, HOST_NAME, STORE_EXTENSION_ID } from './constants.js';
import {
  CONFIG_KEYS,
  configPathHelp,
  getConfigValue,
  isConfigKey,
  loadConfig,
  redactConfig,
  saveConfig,
  setConfigValue,
} from './config.js';
import { decodeNativeMessages, isEpipe } from './framing.js';
import { installNativeHost, uninstallNativeHost, validateExtensionId } from './install.js';
import { meetingsDir } from './paths.js';
import { NativeSyncHost } from './protocol.js';
import { sweepOrphanTmpDirs } from './sessionWriter.js';

export const HELP = `scribetab-host — Chrome native messaging host for ScribeTab

Usage:
  scribetab-host                         Run the native-messaging stdio loop
                                         (Chrome launches this; do not run by hand)
  scribetab-host install [--extension-id ID]
  scribetab-host uninstall
  scribetab-host config get [key]
  scribetab-host config set <key> <value>
  scribetab-host config set notion.token -
  scribetab-host --help

Install copies the host into a stable per-user directory (npx cache is evictable)
and writes the Chrome NativeMessagingHosts manifest:

  macOS:  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json
  Linux:  ~/.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json
  Windows: %APPDATA%\\ScribeTab\\host\\ + HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}

allowed_origins defaults to both the development ID (from the packed key in
the extension manifest) and the Chrome Web Store ID:

  chrome-extension://${DEFAULT_EXTENSION_ID}/
  chrome-extension://${STORE_EXTENSION_ID}/

Pass --extension-id to restrict the manifest to a single custom ID.

Meetings are written to ~/ScribeTab/meetings/<date>-<slug>/.

Host config (Obsidian / Notion, all off by default):
${configPathHelp()}

Keys: ${CONFIG_KEYS.join(', ')}

Set notion.token from stdin (recommended, avoids argv exposure):

  scribetab-host config set notion.token -

obsidianVaultPath must be an absolute path. Config writes are atomic
(temp file + rename, mode 0600) but not locked against concurrent writers.

automations is a JSON array of routing rules. Rules only redirect what an
already-enabled integration writes — they never enable a disabled one:

  scribetab-host config set automations '[{"titleContains":"Acme","destination":"obsidian","subfolder":"Clients/Acme"}]'

An Obsidian subfolder is relative to <vault>/ScribeTab/ and is created if
missing. See apps/native-host/README.md for the full schema.
`;

export function parseExtensionId(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--extension-id') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        throw new Error('--extension-id requires a value');
      }
      return v;
    }
    if (a.startsWith('--extension-id=')) {
      const v = a.slice('--extension-id='.length);
      if (!v) throw new Error('--extension-id requires a value');
      return v;
    }
  }
  return undefined;
}

export function hostScriptPath(): string {
  return fileURLToPath(new URL('./host.bin.js', import.meta.url));
}

export async function runNativeLoop(
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const host = new NativeSyncHost(stdout, env);
  try {
    await sweepOrphanTmpDirs(meetingsDir(env)).catch(() => {});
    stdin.resume();
    for await (const msg of decodeNativeMessages(stdin as AsyncIterable<Uint8Array>)) {
      await host.handle(msg);
    }
  } catch (e) {
    await host.shutdown();
    if (isEpipe(e)) return;
    throw e;
  } finally {
    await host.shutdown();
  }
}

export async function runHostCli(args: string[]): Promise<void> {
  const cmd = args[0];
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'install') {
    const extensionId = parseExtensionId(args.slice(1));
    if (extensionId) validateExtensionId(extensionId);
    const result = await installNativeHost({
      extensionId,
      hostScript: hostScriptPath(),
      nodePath: process.execPath,
    });
    process.stdout.write(
      `Installed ${HOST_NAME}\n  manifest: ${result.manifestPath}\n  launcher: ${result.launcherPath}\n  extensions: ${result.extensionIds.join(', ')}\n`,
    );
    return;
  }
  if (cmd === 'uninstall') {
    const result = await uninstallNativeHost();
    process.stdout.write(`Uninstalled ${HOST_NAME}\n  removed: ${result.manifestPath}\n`);
    return;
  }
  if (cmd === 'config') {
    await runConfigCli(args.slice(1));
    return;
  }
  // Chrome passes chrome-extension://<id>/ as argv[0] (process.argv[2]).
  await runNativeLoop();
}

async function readStdinValue(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function runConfigCli(
  args: string[],
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  } = process,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const sub = args[0];
  if (sub === 'get' || sub === undefined) {
    const cfg = await loadConfig(env, platform);
    const key = args[1];
    if (!key) {
      io.stdout.write(`${JSON.stringify(redactConfig(cfg), null, 2)}\n`);
      return;
    }
    if (!isConfigKey(key)) {
      throw new Error(`Unknown config key ${JSON.stringify(key)}. Valid: ${CONFIG_KEYS.join(', ')}`);
    }
    io.stdout.write(`${getConfigValue(cfg, key)}\n`);
    return;
  }
  if (sub === 'set') {
    const key = args[1];
    if (!key || !isConfigKey(key)) {
      throw new Error(`Usage: scribetab-host config set <key> <value>\nKeys: ${CONFIG_KEYS.join(', ')}`);
    }
    if (args.length > 3) {
      throw new Error('config set takes a single value argument; quote it if it contains spaces');
    }
    let value = args[2];
    if (value === undefined) {
      throw new Error(`Usage: scribetab-host config set <key> <value>\nKeys: ${CONFIG_KEYS.join(', ')}`);
    }
    if (key === 'notion.token' && value === '-') {
      const stdin = io.stdin ?? process.stdin;
      value = await readStdinValue(stdin);
    }
    const cfg = setConfigValue(await loadConfig(env, platform), key, value);
    const path = await saveConfig(cfg, env, platform);
    io.stdout.write(`Wrote ${path}\n`);
    return;
  }
  throw new Error('Usage: scribetab-host config get [key] | config set <key> <value>');
}
