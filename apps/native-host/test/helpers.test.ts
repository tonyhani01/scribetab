import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { encodeNativeMessage } from '../src/framing.js';
import { readNativeMessage } from './helpers.js';

function fakeChild(): ChildProcessWithoutNullStreams & { stdout: PassThrough } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough };
}

describe('readNativeMessage', () => {
  it('delivers both messages when two acks arrive in one stdout chunk', async () => {
    const child = fakeChild();
    child.stdout.write(
      Buffer.concat([
        encodeNativeMessage({ ok: true, sessionId: 'first' }),
        encodeNativeMessage({ ok: true, sessionId: 'second' }),
      ]),
    );
    expect(await readNativeMessage(child, 500)).toEqual({ ok: true, sessionId: 'first' });
    expect(await readNativeMessage(child, 500)).toEqual({ ok: true, sessionId: 'second' });
  });

  it('reassembles a message split across chunks', async () => {
    const child = fakeChild();
    const encoded = encodeNativeMessage({ ok: true, sessionId: 'split' });
    child.stdout.write(encoded.subarray(0, 3));
    const read = readNativeMessage(child, 500);
    child.stdout.write(encoded.subarray(3));
    expect(await read).toEqual({ ok: true, sessionId: 'split' });
  });

  it('still times out when no message arrives', async () => {
    const child = fakeChild();
    child.stderr.write('boom');
    await expect(readNativeMessage(child, 100)).rejects.toThrow(
      /Timed out waiting for native message/,
    );
  });
});
