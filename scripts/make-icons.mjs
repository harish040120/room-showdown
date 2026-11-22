// Generates the PWA icons with zero dependencies: a tiny anti-aliased rasterizer
// (signed distance functions) plus a minimal PNG encoder using node:zlib.
// Run:  node scripts/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// PNG encoder
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Shapes (signed distance: negative inside) in a 512x512 design space
// ---------------------------------------------------------------------------
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function sdRoundRect(x, y, cx, cy, hw, hh, r, ang = 0) {
  let px = x - cx, py = y - cy;
  if (ang) {
    const c = Math.cos(-ang), s = Math.sin(-ang);
    const rx = px * c - py * s, ry = px * s + py * c;
    px = rx; py = ry;
  }
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdHeart(x, y, cx, cy, s) {
  // union of two circles and a 45-degree rotated square
  const a = sdCircle(x, y, cx - s * 0.5, cy - s * 0.15, s * 0.55);
  const b = sdCircle(x, y, cx + s * 0.5, cy - s * 0.15, s * 0.55);
  const c = sdRoundRect(x, y, cx, cy + s * 0.32, s * 0.62, s * 0.62, s * 0.08, Math.PI / 4);
  return Math.min(a, b, c);
}

// Each layer: { sd(x,y) -> distance, color(x,y) -> [r,g,b], alpha }
function drawScene(full) {
  const layers = [];
  const bgTop = hex('#1d2448'), bgBot = hex('#3a1f52');
  // Background: rounded square (or full bleed for maskable / apple icons)
  layers.push({
    sd: full ? () => -1e9 : (x, y) => sdRoundRect(x, y, 256, 256, 256, 256, 96),
    color: (x, y) => {
      const t = clamp01(y / 512);
      const base = mix(bgTop, bgBot, t);
      const g = clamp01(1 - Math.hypot(x - 256, y - 270) / 300) * 0.35;
      return mix(base, hex('#5b4bd6'), g);
    },
  });
  // Floor shadow under the character
  layers.push({ sd: (x, y) => Math.hypot((x - 256) / 1.6, (y - 420) / 0.5) - 70, color: () => [8, 8, 20], alpha: 0.45 });
  // Pistol (behind the hand): barrel + grip
  const gun = hex('#2b3048'), gunTop = hex('#646c96');
  const ink = hex('#0b0d16');
  layers.push({ sd: (x, y) => sdRoundRect(x, y, 392, 300, 80, 22, 10) - 8, color: () => ink });
  layers.push({ sd: (x, y) => sdRoundRect(x, y, 352, 338, 20, 36, 8, -0.25) - 8, color: () => ink });
  layers.push({ sd: (x, y) => sdRoundRect(x, y, 392, 300, 80, 22, 10), color: (x, y) => (y < 292 ? gunTop : gun) });
  layers.push({ sd: (x, y) => sdRoundRect(x, y, 352, 338, 20, 36, 8, -0.25), color: () => gun });
  // Muzzle flash
  layers.push({
    sd: (x, y) => {
      const dx = x - 488, dy = y - 300, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      return r - (26 + 12 * Math.cos(a * 6));
    },
    color: (x, y) => mix(hex('#fff6b0'), hex('#ffb300'), clamp01(Math.hypot(x - 488, y - 300) / 38)),
  });
  // Character body: outline then shaded fill
  layers.push({ sd: (x, y) => sdCircle(x, y, 236, 290, 142), color: () => hex('#0b0d16') });
  layers.push({
    sd: (x, y) => sdCircle(x, y, 236, 290, 130),
    color: (x, y) => {
      const d = clamp01(Math.hypot(x - 190, y - 240) / 200);
      return mix(hex('#ffd36b'), hex('#c47f00'), d);
    },
  });
  // Hand holding the gun
  layers.push({ sd: (x, y) => sdCircle(x, y, 340, 318, 30), color: () => hex('#0b0d16') });
  layers.push({ sd: (x, y) => sdCircle(x, y, 340, 318, 22), color: () => hex('#f2b233') });
  // Eyes looking toward the gun
  for (const ex of [222, 296]) {
    layers.push({ sd: (x, y) => Math.hypot((x - ex) / 1.0, (y - 250) / 1.25) - 26, color: () => [255, 255, 255] });
    layers.push({ sd: (x, y) => sdCircle(x, y, ex + 9, 254, 13), color: () => hex('#141626') });
  }
  // Heart badge (lives)
  layers.push({ sd: (x, y) => sdHeart(x, y, 118, 120, 54) - 8, color: () => hex('#0b0d16') });
  layers.push({
    sd: (x, y) => sdHeart(x, y, 118, 120, 54),
    color: (x, y) => mix(hex('#ff8fa3'), hex('#e0244a'), clamp01((y - 70) / 100)),
  });
  return layers;
}

function render(size, { full = false, inset = 1 } = {}) {
  const layers = drawScene(full);
  const buf = Buffer.alloc(size * size * 4);
  const scale = (size / 512) * inset;
  const off = (size - 512 * scale) / 2;
  const aa = 1 / scale; // one output pixel in design units
  const bgLayer = layers[0];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // design-space coordinates of the pixel center
      let x = (px + 0.5 - off) / scale, y = (py + 0.5 - off) / scale;
      let rgb = [0, 0, 0], a = 0;
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        // in maskable mode the background extends past the (inset) design square
        const d = full && L === bgLayer ? -1e9 : L.sd(x, y);
        const cov = clamp01(0.5 - d / aa) * (L.alpha ?? 1);
        if (cov <= 0) continue;
        const c = L.color(x, y);
        // "over" compositing
        const na = cov + a * (1 - cov);
        rgb = [
          (c[0] * cov + rgb[0] * a * (1 - cov)) / na,
          (c[1] * cov + rgb[1] * a * (1 - cov)) / na,
          (c[2] * cov + rgb[2] * a * (1 - cov)) / na,
        ];
        a = na;
      }
      const o = (py * size + px) * 4;
      buf[o] = Math.round(rgb[0]);
      buf[o + 1] = Math.round(rgb[1]);
      buf[o + 2] = Math.round(rgb[2]);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { full: true, inset: 0.78 }], // keep art inside the safe zone
  ['apple-touch-icon.png', 180, { full: true, inset: 0.9 }],
  ['favicon-32.png', 32, {}],
];
for (const [name, size, opts] of jobs) {
  const png = render(size, opts);
  writeFileSync(join(OUT, name), png);
  console.log(`icons/${name}  ${size}x${size}  ${png.length} bytes`);
}
