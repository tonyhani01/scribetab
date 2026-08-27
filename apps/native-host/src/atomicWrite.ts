import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWriteFile(
  path: string,
  body: string,
  opts: { mode?: number; warn?: (msg: string) => void } = {},
): Promise<void> {
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg));
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    if (opts.mode !== undefined) {
      await writeFile(tmp, body, { encoding: 'utf8', mode: opts.mode });
      try {
        await chmod(tmp, opts.mode);
      } catch {
        warn(`warning: could not chmod ${tmp} to 0o${opts.mode.toString(8)}\n`);
      }
    } else {
      await writeFile(tmp, body, 'utf8');
    }
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
