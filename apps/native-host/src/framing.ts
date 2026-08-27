import { MAX_NATIVE_MESSAGE_BYTES } from './constants.js';

/** Length-prefixed little-endian uint32 + UTF-8 JSON (Chrome native messaging). */
export function encodeNativeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function writeNativeMessage(stdout: NodeJS.WritableStream, msg: unknown): Promise<void> {
  const buf = encodeNativeMessage(msg);
  return new Promise((resolve, reject) => {
    stdout.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

export async function* decodeNativeMessages(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error(`Native message too large: ${len}`);
      }
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      yield JSON.parse(body) as unknown;
    }
  }
}
