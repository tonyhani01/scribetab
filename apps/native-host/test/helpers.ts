import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeNativeMessage } from '../src/framing.js';

const here = dirname(fileURLToPath(import.meta.url));
export const HOST_JS = join(here, '..', 'dist', 'host.bin.js');
export const MCP_JS = join(here, '..', 'dist', 'mcp.bin.js');
export const HOST_LEGACY_JS = join(here, '..', 'dist', 'host.js');

export async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scribetab-home-'));
}

export async function rmrf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function spawnHost(home: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [HOST_JS], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function sendNative(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  child.stdin.write(encodeNativeMessage(msg));
}

// Bytes read off a child's stdout but not yet consumed as a message. Two acks
// written back-to-back often arrive coalesced in one 'data' chunk; without this
// the trailing ack would be dropped and the next read would time out.
const leftovers = new WeakMap<ChildProcessWithoutNullStreams, Buffer>();

export function readNativeMessage(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const err = child.stderr.read()?.toString() ?? '';
      reject(new Error(`Timed out waiting for native message. stderr=${err}`));
    }, timeoutMs);

    const tryConsume = () => {
      const buf = leftovers.get(child) ?? Buffer.alloc(0);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      leftovers.set(child, buf.subarray(4 + len));
      cleanup();
      try {
        resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    };
    const onData = (chunk: Buffer) => {
      leftovers.set(child, Buffer.concat([leftovers.get(child) ?? Buffer.alloc(0), chunk]));
      tryConsume();
    };
    const onExit = (code: number | null) => {
      cleanup();
      const err = child.stderr.read()?.toString() ?? '';
      reject(new Error(`Host exited (${code}) before ack. stderr=${err}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    tryConsume();
  });
}

export async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await tempHome();
  try {
    return await fn(home);
  } finally {
    await rmrf(home);
  }
}
