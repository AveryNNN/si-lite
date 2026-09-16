// Rasterise media/icon.png (128x128) without a browser: supersampled shapes + zlib PNG encoding.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 128;
const SS = 4; // supersampling factor
const W = SIZE * SS;
const px = new Float32Array(W * W * 4);

const lerp = (a, b, t) => a + (b - a) * t;
const inRoundRect = (x, y, rx, ry, rw, rh, r) => {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.max(rx + r, Math.min(x, rx + rw - r));
  const cy = Math.max(ry + r, Math.min(y, ry + rh - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const fill = (test, colorAt) => {
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const ux = (x + 0.5) / SS;
      const uy = (y + 0.5) / SS;
      if (!test(ux, uy)) continue;
      const [r, g, b, a] = colorAt(ux, uy);
      const i = (y * W + x) * 4;
      px[i] = lerp(px[i], r, a);
      px[i + 1] = lerp(px[i + 1], g, a);
      px[i + 2] = lerp(px[i + 2], b, a);
      px[i + 3] = Math.max(px[i + 3], a);
    }
  }
};

// Background: rounded square with a diagonal blue gradient.
fill((x, y) => inRoundRect(x, y, 0, 0, SIZE, SIZE, 26), (x, y) => {
  const t = (x + y) / (2 * SIZE);
  return [lerp(0x1f, 0x0b, t), lerp(0x6f, 0x3d, t), lerp(0xeb, 0x91, t), 1];
});

const white = () => [255, 255, 255, 1];
const stroke = 7;
const strokeRect = (rx, ry, rw, rh, r) =>
  fill((x, y) => inRoundRect(x, y, rx, ry, rw, rh, r) && !inRoundRect(x, y, rx + stroke, ry + stroke, rw - 2 * stroke, rh - 2 * stroke, Math.max(0, r - stroke)), white);
const line = (x1, y1, x2, y2) =>
  fill((x, y) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
    const px_ = x1 + t * dx;
    const py_ = y1 + t * dy;
    return (x - px_) ** 2 + (y - py_) ** 2 <= (stroke / 2) ** 2;
  }, white);

strokeRect(18, 49, 34, 30, 7);
strokeRect(80, 17, 30, 24, 6);
strokeRect(80, 52, 30, 24, 6);
strokeRect(80, 87, 30, 24, 6);
line(52, 64, 66, 64);
line(66, 29, 66, 99);
line(66, 29, 80, 29);
line(66, 64, 80, 64);
line(66, 99, 80, 99);

// Downsample and encode.
const out = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  out[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
      r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
    }
    const n = SS * SS;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = (a / n) * 255;
  }
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(new URL('../media/icon.png', import.meta.url), png);
console.log('media/icon.png', png.length, 'bytes');
