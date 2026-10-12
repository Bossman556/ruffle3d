// Renders the Ruffle3D logo to PNG app icons (no dependencies: tiny rasteriser + PNG encoder).
// Usage: node scripts/make-icons.mjs  →  public/icons/*.png, public/icons/favicon.svg
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons');
mkdirSync(out, { recursive: true });

import { crc32 } from './crc32.mjs';
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// logo geometry in a 24×24 box (same as the in-app SVG)
const hex = [[12, 2.2], [20.6, 7.1], [20.6, 16.9], [12, 21.8], [3.4, 16.9], [3.4, 7.1]];
const lines = [[[3.6, 7.2], [12, 12]], [[12, 12], [20.4, 7.2]], [[12, 12], [12, 21.6]]];
const inPoly = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const segDist = (x, y, [[ax, ay], [bx, by]]) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ORANGE1 = [255, 179, 92], ORANGE2 = [242, 113, 28], BG = [20, 23, 28];

function render(size, { maskable = false, background = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const pad = maskable ? 0.2 : background ? 0.13 : 0.02; // maskable icons keep the logo in the safe zone
  const scale = (size * (1 - 2 * pad)) / 19.6, ox = size * pad - 2.2 * scale + (size * (1 - 2 * pad) - 19.6 * scale) / 2 + 0.2 * scale, oy = size * pad - 2.2 * scale;
  const S = 4; // supersampling
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const X = px + (sx + 0.5) / S, Y = py + (sy + 0.5) / S;
      const x = (X - ox) / scale, y = (Y - oy) / scale;
      let c = null;
      if (maskable || background) {
        const r = size * 0.22, inside = maskable || (Math.max(Math.abs(X - size / 2) - (size / 2 - r), 0) ** 2 + Math.max(Math.abs(Y - size / 2) - (size / 2 - r), 0) ** 2 <= r * r);
        if (inside) c = [...BG, 255];
      }
      if (inPoly(x, y, hex)) {
        const t = Math.max(0, Math.min(1, (x - 3.4 + y - 2.2) / 36.8));
        c = [...mix(ORANGE1, ORANGE2, t), 255];
        if (lines.some((l) => segDist(x, y, l) < 0.7)) c = [...mix(c.slice(0, 3), [255, 255, 255], 0.85), 255];
      }
      if (c) acc = acc.map((v, i) => v + (i < 3 ? c[i] * c[3] : c[3]));
    }
    const a = acc[3];
    const o = (py * size + px) * 4;
    if (a > 0) { buf[o] = acc[0] / a; buf[o + 1] = acc[1] / a; buf[o + 2] = acc[2] / a; buf[o + 3] = a / (S * S); }
  }
  return png(size, size, buf);
}

writeFileSync(path.join(out, 'icon-192.png'), render(192, { background: true }));
writeFileSync(path.join(out, 'icon-512.png'), render(512, { background: true }));
writeFileSync(path.join(out, 'maskable-512.png'), render(512, { maskable: true }));
writeFileSync(path.join(out, 'apple-touch-icon.png'), render(180, { maskable: true }));
writeFileSync(path.join(out, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#f2711c"/></linearGradient></defs><path d="M12 2.2l8.6 4.9v9.8L12 21.8l-8.6-4.9V7.1z" fill="url(#g)"/><path d="M3.6 7.2L12 12l8.4-4.8M12 12v9.6" stroke="#fff" stroke-opacity=".85" stroke-width="1.4" fill="none"/></svg>\n`);
console.log('icons written to', path.relative(root, out));
