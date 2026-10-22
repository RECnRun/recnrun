// Writes the logo as transparent rasters: extension icons, website ICO and touch icon, docs/logo.png (docs/BRAND.md).
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { layers } from "./logo.mjs";

const SIZES = [16, 32, 48, 128];
const LOGO_SIZE = 512;
const SAMPLES = 8;

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const paint = layers.map((layer) => ({ ...layer, color: rgb(layer.color) })).reverse();

const insidePolygon = (polygon, x, y) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const inside = (shape, x, y) =>
  shape.type === "circle"
    ? (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2
    : insidePolygon(shape.points, x, y);
// The topmost layer that covers the point wins, as in the SVG.
const colorAt = (x, y) =>
  paint.find(({ shape, clip }) => inside(shape, x, y) && (!clip || inside(clip, x, y)))?.color;

const points = layers.flatMap(({ shape }) =>
  shape.type === "circle"
    ? [
        [shape.cx - shape.r, shape.cy - shape.r],
        [shape.cx + shape.r, shape.cy + shape.r],
      ]
    : shape.points,
);
const range = (values) => [Math.min(...values), Math.max(...values)];
const [xs, ys] = [range(points.map(([x]) => x)), range(points.map(([, y]) => y))];
// Center each axis on its own midpoint; the longer axis sets the scale.
const [midX, midY] = [(xs[0] + xs[1]) / 2, (ys[0] + ys[1]) / 2];
const span = Math.max(xs[1] - xs[0], ys[1] - ys[0]);

function pixel(size, padding, px, py) {
  const scale = span / (size * (1 - 2 * padding));
  const sum = [0, 0, 0];
  let covered = 0;
  for (let i = 0; i < SAMPLES * SAMPLES; i++) {
    const sx = px + ((i % SAMPLES) + 0.5) / SAMPLES - size / 2;
    const sy = py + (Math.floor(i / SAMPLES) + 0.5) / SAMPLES - size / 2;
    const color = colorAt(midX + sx * scale, midY + sy * scale);
    if (!color) continue;
    covered++;
    color.forEach((channel, c) => (sum[c] += channel));
  }
  const alpha = covered / (SAMPLES * SAMPLES);
  return covered
    ? [...sum.map((s) => Math.round(s / covered)), Math.round(alpha * 255)]
    : [0, 0, 0, 0];
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, padding) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) row.push(...pixel(size, padding, x, y));
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// An ICO whose entries are PNGs, which every current browser reads.
function ico(sizes) {
  const images = sizes.map((size) => png(size, 0.04));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header.set([size, size], entry);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

// iOS browsers ignore SVG favicons, so the website also links these two.
const site = new URL("../apps/website/icons/", import.meta.url);
writeFileSync(new URL("favicon.ico", site), ico([16, 32, 48]));
writeFileSync(new URL("apple-touch-icon.png", site), png(180, 0.12));

const dir = new URL("../apps/extension/public/icon/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of SIZES) writeFileSync(new URL(`${size}.png`, dir), png(size, 0.04));
// Wider margin so avatars that crop to a circle keep the triangle's corners.
writeFileSync(new URL("../docs/logo.png", import.meta.url), png(LOGO_SIZE, 0.12));
