import { fileURLToPath } from 'node:url';
import { DEFAULT_EXTENSION_ID, HOST_NAME } from './constants.js';
import { decodeNativeMessages } from './framing.js';
import { installNativeHost, uninstallNativeHost } from './install.js';
import { NativeSyncHost } from './protocol.js';

export const HELP = `scribetab-host — Chrome native messaging host for ScribeTab

Usage:
  scribetab-host                         Run the native-messaging stdio loop
                                         (Chrome launches this; do not run by hand)
  scribetab-host install [--extension-id ID]
  scribetab-host uninstall
  scribetab-host --help

Install writes the Chrome NativeMessagingHosts manifest for the current user:

  macOS:  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json
  Linux:  ~/.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json
  Windows: %USERPROFILE%\\ScribeTab\\NativeMessagingHosts\\${HOST_NAME}.json
           + HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}

allowed_origins uses chrome-extension://${DEFAULT_EXTENSION_ID}/
(the development ID from the packed key in the extension manifest).
Pass --extension-id to override (required once the Web Store ID is assigned).

Meetings are written to ~/ScribeTab/meetings/<date>-<slug>/.
`;

function parseExtensionId(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--extension-id') return args[i + 1];
    if (a.startsWith('--extension-id=')) return a.slice('--extension-id='.length);
  }
  return undefined;
}

export function hostScriptPath(): string {
  return fileURLToPath(new URL('./host.js', import.meta.url));
}

export async function runNativeLoop(
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const host = new NativeSyncHost(stdout, env);
  stdin.resume();
  for await (const msg of decodeNativeMessages(stdin as AsyncIterable<Uint8Array>)) {
    await host.handle(msg);
  }
}

export async function runHostCli(args: string[]): Promise<void> {
  const cmd = args[0];
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'install') {
    const result = await installNativeHost({
      extensionId: parseExtensionId(args.slice(1)),
      hostScript: hostScriptPath(),
      nodePath: process.execPath,
    });
    process.stdout.write(
      `Installed ${HOST_NAME}\n  manifest: ${result.manifestPath}\n  launcher: ${result.launcherPath}\n  extension: ${result.extensionId}\n`,
    );
    return;
  }
  if (cmd === 'uninstall') {
    const result = await uninstallNativeHost();
    process.stdout.write(`Uninstalled ${HOST_NAME}\n  removed: ${result.manifestPath}\n`);
    return;
  }
  // Chrome passes chrome-extension://<id>/ as argv[0] (process.argv[2]).
  await runNativeLoop();
}
