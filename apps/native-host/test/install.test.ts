import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSION_ID, HOST_NAME } from '../src/constants.js';
import { parseExtensionId } from '../src/cli.js';
import {
  chromeNativeMessagingDir,
  installNativeHost,
  stableHostDir,
  uninstallNativeHost,
  validateExtensionId,
} from '../src/install.js';
import { withHome } from './helpers.js';

describe('installNativeHost', () => {
  it('copies into a stable dir and writes the Chrome manifest under a temp HOME on macOS', async () => {
    await withHome(async (home) => {
      const env = { HOME: home, USERPROFILE: home };
      const srcDir = join(home, 'src-dist');
      await mkdir(srcDir, { recursive: true });
      const hostScript = join(srcDir, 'host.bin.js');
      await writeFile(hostScript, 'console.log("host")\n', 'utf8');
      const result = await installNativeHost({
        platform: 'darwin',
        env,
        hostScript,
        nodePath: '/usr/bin/node',
      });
      expect(result.extensionId).toBe(DEFAULT_EXTENSION_ID);
      expect(result.manifestPath).toBe(
        join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST_NAME}.json`),
      );
      expect(result.launcherPath).toBe(join(stableHostDir('darwin', env), 'scribetab-host'));
      const json = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
        name: string;
        path: string;
        type: string;
        allowed_origins: string[];
      };
      expect(json.name).toBe(HOST_NAME);
      expect(json.type).toBe('stdio');
      expect(json.path).toBe(result.launcherPath);
      expect(json.allowed_origins).toEqual([`chrome-extension://${DEFAULT_EXTENSION_ID}/`]);
      const launcher = await readFile(result.launcherPath, 'utf8');
      expect(launcher).toContain(join(stableHostDir('darwin', env), 'dist', 'host.bin.js'));
    });
  });

  it('honors --extension-id and uninstall removes the manifest', async () => {
    await withHome(async (home) => {
      const env = { HOME: home };
      const custom = 'abcdefghijklmnopabcdefghijklmnop';
      const installed = await installNativeHost({
        platform: 'linux',
        env,
        extensionId: custom,
        hostScript: '/x/host.js',
        nodePath: '/usr/bin/node',
      });
      expect(chromeNativeMessagingDir('linux', env)).toBe(
        join(home, '.config/google-chrome/NativeMessagingHosts'),
      );
      const json = JSON.parse(await readFile(installed.manifestPath, 'utf8')) as {
        allowed_origins: string[];
      };
      expect(json.allowed_origins).toEqual([`chrome-extension://${custom}/`]);
      await uninstallNativeHost({ platform: 'linux', env });
      await expect(readFile(installed.manifestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects invalid extension ids and a bare --extension-id flag', () => {
    expect(() => validateExtensionId('not-an-id')).toThrow(/Invalid extension id/);
    expect(() => parseExtensionId(['--extension-id'])).toThrow(/requires a value/);
    expect(() => parseExtensionId(['--extension-id='])).toThrow(/requires a value/);
  });
});
