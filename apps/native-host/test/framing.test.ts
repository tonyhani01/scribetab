import { describe, expect, it } from 'vitest';
import { decodeNativeMessages, encodeNativeMessage } from '../src/framing.js';

describe('native messaging framing', () => {
  it('round-trips JSON with a little-endian length prefix', async () => {
    const msg = { type: 'sync_end', sessionId: 'abc' };
    const framed = encodeNativeMessage(msg);
    expect(framed.readUInt32LE(0)).toBe(framed.length - 4);
    expect(JSON.parse(framed.subarray(4).toString('utf8'))).toEqual(msg);

    async function* chunks() {
      yield framed.subarray(0, 3);
      yield framed.subarray(3);
    }
    const out: unknown[] = [];
    for await (const m of decodeNativeMessages(chunks())) out.push(m);
    expect(out).toEqual([msg]);
  });

  it('decodes a header read mid-chunk whose body arrives later (regression: stream desync)', async () => {
    // msg1 ends partway through a chunk that also carries msg2's header and a
    // partial body; the rest of msg2 arrives in the next chunk. The buggy
    // decoder re-read already-consumed bytes after stashing the header.
    const msg1 = { type: 'sync_begin', sessionId: 'a' };
    const msg2 = { type: 'sync_audio_chunk', sessionId: 'a', wavBase64: 'A'.repeat(4096) };
    const f1 = encodeNativeMessage(msg1);
    const f2 = encodeNativeMessage(msg2);
    const all = Buffer.concat([f1, f2]);
    // First chunk: all of msg1 + msg2's header + a sliver of msg2's body.
    const split = f1.length + 4 + 10;
    async function* chunks() {
      yield all.subarray(0, split);
      yield all.subarray(split);
    }
    const out: unknown[] = [];
    for await (const m of decodeNativeMessages(chunks())) out.push(m);
    expect(out).toEqual([msg1, msg2]);
  });

  it('decodes many messages split at every possible boundary', async () => {
    const msgs = [{ a: 1 }, { b: 'x'.repeat(300) }, { c: [1, 2, 3] }];
    const all = Buffer.concat(msgs.map((m) => encodeNativeMessage(m)));
    for (let split = 1; split < all.length; split++) {
      async function* chunks() {
        yield all.subarray(0, split);
        yield all.subarray(split);
      }
      const out: unknown[] = [];
      for await (const m of decodeNativeMessages(chunks())) out.push(m);
      expect(out).toEqual(msgs);
    }
  });

  it('throws on truncated framing at EOF', async () => {
    const framed = encodeNativeMessage({ ok: true });
    async function* trunc() {
      yield framed.subarray(0, 2);
    }
    await expect(async () => {
      for await (const _ of decodeNativeMessages(trunc())) {
        // drain
      }
    }).rejects.toThrow(/truncated/);
  });
});
