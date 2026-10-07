import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { opaqueTrayPng, trayIconDataUrl } from '../electron/tray-icon.mjs';

function decodeTrayPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idats: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === 'IDAT') {
      idats.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = 1 + width * 4;
  expect(raw.length).toBe(height * stride);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0);
    raw.copy(pixels, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, pixels };
}

describe('tray icon', () => {
  it('is a 16x16 mark whose every pixel is opaque', () => {
    const png = opaqueTrayPng();
    const { width, height, pixels } = decodeTrayPng(png);
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(png.length).toBeGreaterThan(80);
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
    const colors = new Set<string>();
    for (let i = 0; i < pixels.length; i += 4) colors.add(pixels.subarray(i, i + 3).toString('hex'));
    expect(colors.size).toBeGreaterThan(1);
    expect(trayIconDataUrl()).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });
});
