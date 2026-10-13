#!/usr/bin/env node
/**
 * Generates the PWA icons in apps/app/client/public from the brand mark, with Node built-ins
 * only (zlib for PNG's deflate, no image library) plus a local Chrome to rasterise the SVG:
 *
 *   icon-512.png / icon-192.png — the mark (public/favicon.svg, D-019) rendered by headless
 *     Chrome at 1024px and averaged down. Skipped with --no-render (then icon-512.png is the
 *     source). Chrome is $CHROME, else `google-chrome`.
 *   icon-maskable-512.png / icon-maskable-192.png — the icon shrunk to 80% and centred on its
 *     own background colour. A maskable icon is cropped by the OS to any shape (circle, squircle)
 *     inside the central 80% "safe zone"; without padding the artwork's edges get cut off.
 *   apple-touch-icon.png — 180×180, the size iOS asks for; iOS rounds the corners itself.
 *
 * The draft board (apps/web/public) gets the same icon-192/512.
 *
 * Re-run after changing favicon.svg:  node tools/make-pwa-icons.mjs
 * Handles 8-bit, non-interlaced RGB/RGBA PNGs (what Chrome writes); anything else is refused.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const PUBLIC = new URL('../apps/app/client/public/', import.meta.url);
const DRAFT_PUBLIC = new URL('../apps/web/public/', import.meta.url);
const RENDER_PX = 1024;
const SAFE_ZONE = 0.8;

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Decodes to { width, height, rgba } (4 bytes per pixel). */
function decode(file) {
  const png = readFileSync(file);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error('only 8-bit non-interlaced RGB/RGBA PNGs are supported');
      }
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      pixels[y * stride + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = pixels[i * bpp];
    rgba[i * 4 + 1] = pixels[i * bpp + 1];
    rgba[i * 4 + 2] = pixels[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? pixels[i * bpp + 3] : 255;
  }
  return { width, height, rgba };
}

/** Encodes opaque RGB (the icons are opaque, and iOS renders alpha as black anyway). */
function encode(img) {
  const { width, height, rgba } = img;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      for (let k = 0; k < 3; k += 1) {
        raw[y * (width * 3 + 1) + 1 + x * 3 + k] = rgba[(y * width + x) * 4 + k];
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Area-averaging resize: every source pixel contributes to the destination pixel it covers. */
function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = src.width / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      const sum = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          for (let k = 0; k < 4; k += 1) sum[k] += src.rgba[(sy * src.width + sx) * 4 + k];
        }
      }
      const n = (x1 - x0) * (y1 - y0);
      for (let k = 0; k < 4; k += 1) out[(y * size + x) * 4 + k] = Math.round(sum[k] / n);
    }
  }
  return { width: size, height: size, rgba: out };
}

/** The icon at SAFE_ZONE of `size`, centred on a canvas filled with the icon's corner colour. */
function maskable(src, size) {
  const inner = resize(src, Math.round(size * SAFE_ZONE));
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) src.rgba.copy(out, i * 4, 0, 4);
  const offset = Math.floor((size - inner.width) / 2);
  for (let y = 0; y < inner.height; y += 1) {
    inner.rgba.copy(
      out,
      ((y + offset) * size + offset) * 4,
      y * inner.width * 4,
      (y + 1) * inner.width * 4,
    );
  }
  return { width: size, height: size, rgba: out };
}

/** The top-left size×size of an image. */
function crop(src, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    src.rgba.copy(out, y * size * 4, y * src.width * 4, (y * src.width + size) * 4);
  }
  return { width: size, height: size, rgba: out };
}

/** Rasterises public/favicon.svg with headless Chrome (a page sized to it, then cropped). */
function renderMark() {
  const dir = mkdtempSync(join(tmpdir(), 'fha-icons-'));
  try {
    const svg = fileURLToPath(new URL('favicon.svg', PUBLIC));
    const page = join(dir, 'mark.html');
    const shot = join(dir, 'mark.png');
    writeFileSync(
      page,
      `<!doctype html><body style="margin:0"><img src="file://${svg}" width="${RENDER_PX}" height="${RENDER_PX}" style="display:block"></body>`,
    );
    execFileSync(process.env.CHROME ?? 'google-chrome', [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox', // a local file we wrote; the sandbox fails in some containers
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      `--window-size=${RENDER_PX},${RENDER_PX + 200}`,
      `--screenshot=${shot}`,
      `file://${page}`,
    ]);
    return crop(decode(shot), RENDER_PX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!process.argv.includes('--no-render')) {
  const mark = renderMark();
  for (const size of [512, 192]) {
    writeFileSync(new URL(`icon-${size}.png`, PUBLIC), encode(resize(mark, size)));
    console.log(`wrote public/icon-${size}.png (${size}×${size})`);
  }
}

const source = decode(new URL('icon-512.png', PUBLIC));
const outputs = {
  'icon-maskable-512.png': maskable(source, 512),
  'icon-maskable-192.png': maskable(source, 192),
  'apple-touch-icon.png': resize(source, 180),
};
for (const [name, img] of Object.entries(outputs)) {
  writeFileSync(new URL(name, PUBLIC), encode(img));
  console.log(`wrote public/${name} (${img.width}×${img.height})`);
}
for (const name of ['icon-192.png', 'icon-512.png']) {
  copyFileSync(new URL(name, PUBLIC), new URL(name, DRAFT_PUBLIC));
  console.log(`copied ${name} to apps/web/public`);
}
