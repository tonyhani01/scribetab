#!/usr/bin/env node
/** Dev-dep-free PNG icons: rounded square + ST monogram. */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = [
  '.###.',
  '#....',
  '#....',
  '.###.',
  '....#',
  '....#',
  '.###.',
];
const T = [
  '#####',
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '..#..',
];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

function inRoundedRect(x, y, size, r) {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const ix = x < r ? r - x : x >= size - r ? x - (size - 1 - r) : 0;
  const iy = y < r ? r - y : y >= size - r ? y - (size - 1 - r) : 0;
  if (ix && iy) return ix * ix + iy * iy <= r * r;
  return true;
}

function blit(rgba, size, glyph, ox, oy, scale, color) {
  for (let gy = 0; gy < glyph.length; gy++) {
    for (let gx = 0; gx < glyph[0].length; gx++) {
      if (glyph[gy][gx] !== '#') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = ox + gx * scale + dx;
          const y = oy + gy * scale + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const i = (y * size + x) * 4;
          rgba[i] = color[0];
          rgba[i + 1] = color[1];
          rgba[i + 2] = color[2];
          rgba[i + 3] = 255;
        }
      }
    }
  }
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = Math.max(2, Math.round(size * 0.22));
  const bg = [27, 79, 114];
  const fg = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y, size, r)) continue;
      rgba[i] = bg[0];
      rgba[i + 1] = bg[1];
      rgba[i + 2] = bg[2];
      rgba[i + 3] = 255;
    }
  }
  const scale = Math.max(1, Math.floor(size / 14));
  const gw = 5 * scale;
  const gh = 7 * scale;
  const gap = Math.max(1, Math.round(scale * 0.6));
  const ox = Math.floor((size - (gw * 2 + gap)) / 2);
  const oy = Math.floor((size - gh) / 2);
  blit(rgba, size, S, ox, oy, scale, fg);
  blit(rgba, size, T, ox + gw + gap, oy, scale, fg);
  return encodePng(size, size, rgba);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public');
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon-${size}.png`), draw(size));
}
console.log('wrote icon-16/32/48/128.png');
