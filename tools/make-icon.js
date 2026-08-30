#!/usr/bin/env node
/*
 * Draws Hearth's app icon for every platform that needs one.
 *
 *   node tools/make-icon.js iconset <dir>   macOS .iconset (feed to iconutil)
 *   node tools/make-icon.js ico <file>      Windows .ico
 *   node tools/make-icon.js png <file>      single 512px png (Linux)
 *
 * Written by hand with zlib rather than pulling in an image library, so the
 * build stays dependency-free. It is the same ember the web UI uses, so the
 * Dock icon, the taskbar icon and the window all agree.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- minimal PNG writer -----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the artwork ------------------------------------------------------------

const STOPS = [
  [0.00, [255, 214, 150]],  // hot centre
  [0.42, [255, 157, 77]],   // --ember
  [1.00, [193, 68, 12]],    // cooling edge
];

function sample(t) {
  const u = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (u <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const k = (u - t0) / (t1 - t0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// Distance from a point to a thick line segment with rounded caps - the whole
// glyph is built from these, which keeps it crisp at 16px and at 1024px.
function capsule(px, py, x1, y1, x2, y2, radius) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = px - (x1 + vx * t), dy = py - (y1 + vy * t);
  return Math.sqrt(dx * dx + dy * dy) - radius;
}

// A prompt chevron and cursor: this is a terminal, and the icon should say so
// before you have read the name. The chevron is cream; the cursor is blue — a
// small cool accent against the ember, echoed in the app and on the site.
function chevronDistance(sx, sy, cx, cy, box) {
  const u = (v) => v * box;
  const stroke = u(0.062);
  const X = (v) => cx + u(v), Y = (v) => cy + u(v);
  const upper = capsule(sx, sy, X(-0.26), Y(-0.20), X(-0.02), Y(0.015), stroke);
  const lower = capsule(sx, sy, X(-0.02), Y(0.015), X(-0.26), Y(0.23), stroke);
  return Math.min(upper, lower);
}
function cursorDistance(sx, sy, cx, cy, box) {
  const u = (v) => v * box;
  const stroke = u(0.062);
  const X = (v) => cx + u(v), Y = (v) => cy + u(v);
  return capsule(sx, sy, X(0.07), Y(0.235), X(0.30), Y(0.235), stroke);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const margin = size * 0.06;          // macOS icons sit inside a small margin
  const box = size - margin * 2;
  const radius = box * 0.225;          // the familiar rounded-square silhouette
  const cx = size / 2, cy = size / 2;
  const half = box / 2;

  // The glow originates low and centre, the way a fire actually lights a shape.
  const gx = cx, gy = cy + box * 0.30;
  const reach = box * 0.98;
  const aa = Math.max(0.8, size / 128);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5, sy = y + 0.5;

      // signed distance to a rounded rectangle
      const dx = Math.max(Math.abs(sx - cx) - (half - radius), 0);
      const dy = Math.max(Math.abs(sy - cy) - (half - radius), 0);
      const dist = Math.sqrt(dx * dx + dy * dy) - radius;

      let alpha = 0.5 - dist / aa;
      alpha = Math.max(0, Math.min(1, alpha));
      if (alpha <= 0) continue;

      const gd = Math.sqrt((sx - gx) ** 2 + (sy - gy) ** 2) / reach;
      let [r, g, b] = sample(gd);

      // Lay the prompt over the ember, antialiased the same way as the edge.
      // Chevron in cream, cursor in a cool blue.
      const chev = Math.max(0, Math.min(1, 0.5 - chevronDistance(sx, sy, cx, cy, box) / aa));
      if (chev > 0) {
        r = Math.round(r + (255 - r) * chev);
        g = Math.round(g + (247 - g) * chev);
        b = Math.round(b + (235 - b) * chev);
      }
      const cur = Math.max(0, Math.min(1, 0.5 - cursorDistance(sx, sy, cx, cy, box) / aa));
      if (cur > 0) {
        r = Math.round(r + (120 - r) * cur);   // #6fc6ff — a bit of blue
        g = Math.round(g + (198 - g) * cur);
        b = Math.round(b + (255 - b) * cur);
      }

      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// --- ICO -------------------------------------------------------------------

// Windows accepts PNG-compressed entries inside an .ico, which keeps this to a
// header plus the same images the other platforms use.
function encodeICO(sizes) {
  const images = sizes.map((size) => ({ size, png: encodePNG(size, size, draw(size)) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;

  images.forEach((img, i) => {
    const at = i * 16;
    entries[at] = img.size >= 256 ? 0 : img.size;      // 0 means 256
    entries[at + 1] = img.size >= 256 ? 0 : img.size;
    entries[at + 2] = 0;                                // palette size
    entries[at + 3] = 0;                                // reserved
    entries.writeUInt16LE(1, at + 4);                   // colour planes
    entries.writeUInt16LE(32, at + 6);                  // bits per pixel
    entries.writeUInt32LE(img.png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

// --- cli --------------------------------------------------------------------

const ICONSET = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

const mode = process.argv[2] || 'iconset';
const target = process.argv[3];

if (mode === 'iconset') {
  const outDir = target || path.join(__dirname, '..', 'Hearth.iconset');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [size, name] of ICONSET) {
    fs.writeFileSync(path.join(outDir, name), encodePNG(size, size, draw(size)));
  }
  console.log('icon: wrote ' + ICONSET.length + ' images to ' + outDir);
} else if (mode === 'ico') {
  const out = target || 'icon.ico';
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, encodeICO([16, 32, 48, 64, 128, 256]));
  console.log('icon: wrote ' + out);
} else if (mode === 'png') {
  const out = target || 'icon.png';
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, encodePNG(512, 512, draw(512)));
  console.log('icon: wrote ' + out);
} else {
  console.error('usage: make-icon.js [iconset|ico|png] <output>');
  process.exit(1);
}
