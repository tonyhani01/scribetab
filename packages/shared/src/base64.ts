/**
 * Chunk-safe ArrayBuffer → base64. Spreading a large Uint8Array into
 * `String.fromCharCode(...)` overflows the call stack.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const parts: string[] = [];
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + step)));
  }
  return btoa(parts.join(''));
}
