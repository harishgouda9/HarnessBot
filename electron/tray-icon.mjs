import zlib from 'node:zlib';

/**
 * 16×16 tray mark. Every pixel has alpha 255 so hide-on-close still leaves
 * something visible to click. No image library: this is a PNG built in place.
 */

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function opaqueTrayPng() {
  const size = 16;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const border = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const stem = (x >= 3 && x <= 5 && y >= 3 && y <= 12) || (x >= 10 && x <= 12 && y >= 3 && y <= 12);
      const bridge = y >= 7 && y <= 8 && x >= 3 && x <= 12;
      let r = 0xc4;
      let g = 0x5c;
      let b = 0x26;
      if (border) {
        r = 0x1c;
        g = 0x14;
        b = 0x0c;
      } else if (stem || bridge) {
        r = 0xff;
        g = 0xf6;
        b = 0xe8;
      }
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function trayIconDataUrl() {
  return `data:image/png;base64,${opaqueTrayPng().toString('base64')}`;
}
