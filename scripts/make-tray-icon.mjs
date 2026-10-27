// Writes assets/tray-icon.png: a 32x32 amber circle with a dark cat-eye
// slit, generated here so the repository needs no binary tooling. Run with
// `node scripts/make-tray-icon.mjs` after changing the drawing.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const size = 32;
const rows = [];
for (let y = 0; y < size; y += 1) {
  const row = [0];
  for (let x = 0; x < size; x += 1) {
    const dx = x + 0.5 - size / 2;
    const dy = y + 0.5 - size / 2;
    const distance = Math.sqrt(dx * dx + dy * dy);
    let rgba = [0, 0, 0, 0];
    if (distance <= 15) {
      rgba = [217, 138, 43, 255];
      if (distance >= 14) rgba = [140, 86, 20, 255];
      if (Math.abs(dx) <= 1.6 && Math.abs(dy) <= 7) rgba = [43, 42, 38, 255];
    }
    row.push(...rgba);
  }
  rows.push(Buffer.from(row));
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
]);
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tray-icon.png');
writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes)`);
