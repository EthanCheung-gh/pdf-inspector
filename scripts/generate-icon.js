#!/usr/bin/env node
/**
 * Generate build/icon.png (512x512) deterministically — no dependencies.
 * Flat indigo rounded square + white document + amber magnifier.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

// CRC32 table for PNG chunks
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---------- pixel painting ----------
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function fillRoundedRect(x0, y0, x1, y1, radius, [r, g, b]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = Math.max(x0 + radius, Math.min(x, x1 - radius - 1));
      const cy = Math.max(y0 + radius, Math.min(y, y1 - radius - 1));
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPx(x, y, r, g, b);
    }
  }
}

function fillRect(x0, y0, x1, y1, [r, g, b]) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(x, y, r, g, b);
}

function fillCircle(cx, cy, radius, [r, g, b]) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPx(x, y, r, g, b);
    }
  }
}

function strokeCircle(cx, cy, radius, thickness, color) {
  for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(d - radius) <= thickness / 2) setPx(x, y, ...color);
    }
  }
}

function strokeLine(x0, y0, x1, y1, thickness, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    fillCircle(x, y, Math.ceil(thickness / 2), color);
  }
}

// Background: indigo rounded square with margin
fillRoundedRect(16, 16, SIZE - 16, SIZE - 16, 96, [79, 70, 229]);

// Document: white sheet with folded corner
const DOC = { x0: 156, y0: 116, x1: 326, y1: 396, fold: 40 };
fillRect(DOC.x0, DOC.y0 + DOC.fold, DOC.x1, DOC.y1, [248, 250, 252]);
fillRect(DOC.x0, DOC.y0, DOC.x1 - DOC.fold, DOC.y0 + DOC.fold, [248, 250, 252]);
// fold triangle (darker)
for (let i = 0; i < DOC.fold; i++) {
  for (let j = 0; j <= i; j++) {
    setPx(DOC.x1 - DOC.fold + j, DOC.y0 + i, 203, 213, 225);
  }
}
// text lines
for (let row = 0; row < 5; row++) {
  const y = DOC.y0 + 80 + row * 44;
  const w = row === 4 ? 90 : 130;
  fillRect(DOC.x0 + 24, y, DOC.x0 + 24 + w, y + 14, [148, 163, 184]);
}

// Magnifier: amber ring + handle, overlapping document bottom-right
const MAG = { cx: 330, cy: 330, r: 78, t: 26 };
strokeCircle(MAG.cx, MAG.cy, MAG.r, MAG.t, [245, 158, 11]);
strokeLine(MAG.cx + 58, MAG.cy + 58, MAG.cx + 118, MAG.cy + 118, 30, [245, 158, 11]);

// ---------- PNG encoding ----------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.subarray
    ? raw.set(px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1)
    : null;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
