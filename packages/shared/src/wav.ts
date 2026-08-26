/** 44-byte header for a 16-bit mono PCM WAV file with the given data length. */
export function wavHeader(dataByteLength: number, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);
  return buf;
}

/** Encode mono float32 PCM as a complete 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const out = new Uint8Array(44 + dataLength);
  out.set(new Uint8Array(wavHeader(dataLength, sampleRate)), 0);
  const view = new DataView(out.buffer);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return out.buffer;
}
