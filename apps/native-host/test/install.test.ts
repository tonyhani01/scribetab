import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSION_ID, HOST_NAME } from '../src/constants.js';
import { chromeNativeMessagingDir, installNativeHost, uninstallNativeHost } from '../src/install.js';
import { withHome } from './helpers.js';

describe('installNativeHost', () => {
  it('writes the Chrome manifest under a temp HOME on macOS', async () => {
    await withHome(async (home) => {
      const env = { HOME: home, USERPROFILE: home };
      const result = await installNativeHost({
        platform: 'darwin',
        env,
        hostScript: '/opt/scribetab/dist/host.js',
        nodePath: '/usr/bin/node',
      });
      expect(result.extensionId).toBe(DEFAULT_EXTENSION_ID);
      expect(result.manifestPath).toBe(
        join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST_NAME}.json`),
      );
      const json = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
        name: string;
        path: string;
        type: string;
        allowed_origins: string[];
      };
      expect(json.name).toBe(HOST_NAME);
      expect(json.type).toBe('stdio');
      expect(json.path).toBe(join(home, 'ScribeTab', 'bin', 'scribetab-host'));
      expect(json.allowed_origins).toEqual([`chrome-extension://${DEFAULT_EXTENSION_ID}/`]);
    });
  });

  it('honors --extension-id and uninstall removes the manifest', async () => {
    await withHome(async (home) => {
      const env = { HOME: home };
      const custom = 'abcdefghijklmnopqrstuvwxyzabcdef';
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
});
