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
});
