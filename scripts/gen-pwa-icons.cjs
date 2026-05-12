#!/usr/bin/env node
// Generates placeholder PWA icons under src/web/static/icons.
// Solid background + centered inner square. Replace with branded art when ready.
// Run with `node scripts/gen-pwa-icons.cjs`.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT_DIR = path.resolve(__dirname, "..", "src", "web", "static", "icons");

// Palette mirrors styles.css :root.
const TEXT = [0xd8, 0xdd, 0xd7];   // --text (light)
const BG = [0x0d, 0x0e, 0x0d];     // --bg (near-black)

let crcTable = null;
function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function renderPng(size, opts) {
  const { background, accent, accentInsetPct } = opts;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const inset = Math.floor(size * accentInsetPct);
  const accentLo = inset;
  const accentHi = size - inset;

  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: none
    const inAccentY = y >= accentLo && y < accentHi;
    for (let x = 0; x < size; x++) {
      const o = y * rowLen + 1 + x * 3;
      const useAccent = inAccentY && x >= accentLo && x < accentHi;
      const c = useAccent ? accent : background;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const writes = [
  // any-purpose: light bg, dark center accent — visible on dark home screens.
  { name: "icon-192.png", size: 192, opts: { background: TEXT, accent: BG, accentInsetPct: 0.28 } },
  { name: "icon-512.png", size: 512, opts: { background: TEXT, accent: BG, accentInsetPct: 0.28 } },
  // maskable: full-bleed bg, accent inside the 80% safe zone.
  { name: "icon-maskable-192.png", size: 192, opts: { background: TEXT, accent: BG, accentInsetPct: 0.32 } },
  { name: "icon-maskable-512.png", size: 512, opts: { background: TEXT, accent: BG, accentInsetPct: 0.32 } }
];

for (const w of writes) {
  const buf = renderPng(w.size, w.opts);
  fs.writeFileSync(path.join(OUT_DIR, w.name), buf);
  console.log(`wrote ${w.name} (${buf.length} bytes)`);
}
