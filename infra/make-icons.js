#!/usr/bin/env node
// One-off icon generator (NOT part of deploy). Pure Node, no deps — writes
// opaque PNG dumbbell icons into public/icons/. Re-run if the brand changes:
//   node infra/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- minimal PNG encoder (RGB, 8-bit) ---------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- draw a dumbbell --------------------------------------------------------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#14181d'), ACCENT = hex('#40c057');
function render(size) {
  const buf = Buffer.alloc(size * size * 3);
  const cy = size / 2;
  const band = (a, b) => (x) => x >= a * size && x <= b * size; // horizontal x-range test
  const plate = (x, y) => (band(0.18, 0.30)(x) || band(0.70, 0.82)(x)) && Math.abs(y - cy) <= 0.24 * size;
  const collar = (x, y) => (band(0.30, 0.35)(x) || band(0.65, 0.70)(x)) && Math.abs(y - cy) <= 0.15 * size;
  const bar = (x, y) => band(0.35, 0.65)(x) && Math.abs(y - cy) <= 0.06 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = plate(x, y) || collar(x, y) || bar(x, y);
      const col = on ? ACCENT : BG;
      const i = (y * size + x) * 3;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2];
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, render(size)));
  console.log('wrote', path.relative(path.join(__dirname, '..'), file), fs.statSync(file).size, 'bytes');
}
