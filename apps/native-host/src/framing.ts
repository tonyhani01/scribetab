import { MAX_NATIVE_MESSAGE_BYTES } from './constants.js';

/** Length-prefixed little-endian uint32 + UTF-8 JSON (Chrome native messaging). */
export function encodeNativeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function isEpipe(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EPIPE'
  );
}

export function writeNativeMessage(stdout: NodeJS.WritableStream, msg: unknown): Promise<void> {
  const buf = encodeNativeMessage(msg);
  return new Promise((resolve, reject) => {
    stdout.write(buf, (err) => {
      if (!err) {
        resolve();
        return;
      }
      if (isEpipe(err)) resolve();
      else reject(err);
    });
  });
}

function takeBytes(chunks: Buffer[], offsetRef: { n: number }, n: number): Buffer {
  const out = Buffer.allocUnsafe(n);
  let copied = 0;
  while (copied < n) {
    const cur = chunks[0];
    if (!cur) throw new Error('Native framing underflow');
    const start = offsetRef.n;
    const take = Math.min(n - copied, cur.length - start);
    cur.copy(out, copied, start, start + take);
    copied += take;
    offsetRef.n += take;
    if (offsetRef.n >= cur.length) {
      chunks.shift();
      offsetRef.n = 0;
    }
  }
  return out;
}

export async function* decodeNativeMessages(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const chunks: Buffer[] = [];
  const offsetRef = { n: 0 };
  let buffered = 0;
  // Body length parsed from a consumed header whose body has not arrived yet.
  // Headers are never un-consumed; this carries the state across reads instead.
  let pendingLen: number | null = null;

  for await (const chunk of stream) {
    if (chunk.byteLength === 0) continue;
    chunks.push(Buffer.from(chunk));
    buffered += chunk.byteLength;
    for (;;) {
      if (pendingLen === null) {
        if (buffered < 4) break;
        const header = takeBytes(chunks, offsetRef, 4);
        buffered -= 4;
        const len = header.readUInt32LE(0);
        if (len > MAX_NATIVE_MESSAGE_BYTES) {
          throw new Error(`Native message too large: ${len}`);
        }
        pendingLen = len;
      }
      if (buffered < pendingLen) break;
      const body = takeBytes(chunks, offsetRef, pendingLen);
      buffered -= pendingLen;
      pendingLen = null;
      try {
        yield JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        throw new Error('Malformed native message JSON');
      }
    }
  }

  if (buffered > 0 || pendingLen !== null) {
    throw new Error('Malformed native framing: truncated message');
  }
}
