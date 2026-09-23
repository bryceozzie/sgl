// Writes the PWA's placeholder icons (DD-08 §12: 192 and 512 px, maskable) to
// apps/web/public/icons/. Placeholders, not a designed mark: a full-bleed
// background (maskable) with three boxes and two connectors, all inside the
// central 60 % so any mask shape keeps them. No image library — a PNG is a
// signature, IHDR, one zlib-compressed IDAT and IEND, so Node's own zlib
// suffices. Run: node apps/web/scripts/generate-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
const BG = [0x1b, 0x23, 0x30];
const FG = [0xf7, 0xf8, 0xfa];
const ACCENT = [0x60, 0xa5, 0xfa];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, paint) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = paint(x / size, y / size);
      const at = y * (size * 3 + 1) + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Unit-square geometry: one box on top, two below, joined by connectors.
const boxes = [
  { x: 0.38, y: 0.24, w: 0.24, h: 0.16 },
  { x: 0.22, y: 0.6, w: 0.24, h: 0.16 },
  { x: 0.54, y: 0.6, w: 0.24, h: 0.16 },
];
const inBox = (u, v, b) => u >= b.x && u <= b.x + b.w && v >= b.y && v <= b.y + b.h;
function nearSegment(u, v, x0, y0, x1, y1, half) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(u - (x0 + t * dx), v - (y0 + t * dy)) <= half;
}

function paint(u, v) {
  if (boxes.some((b) => inBox(u, v, b))) return FG;
  if (nearSegment(u, v, 0.5, 0.4, 0.34, 0.6, 0.018) || nearSegment(u, v, 0.5, 0.4, 0.66, 0.6, 0.018)) return ACCENT;
  return BG;
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) writeFileSync(new URL(`icon-${size}.png`, OUT), png(size, paint));
