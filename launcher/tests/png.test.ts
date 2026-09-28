import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { cropImage, decodePng, encodePng, type RgbaImage } from '../src/previews/png';
import { trimToModel } from '../src/previews/thumbnails';

/**
 * The previews' PNG round trip, without Electron: what the engine's canvas
 * writes decodes to its pixels whatever filter each row used, a crop keeps
 * exactly its rectangle, and a trim cuts the transparent border down to the
 * model plus its margin.
 */

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, pixels };
}

const gradient = image(7, 5, (x, y) => [x * 30, y * 50, (x * y * 13) % 256, 200 + x]);

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
  return a <= b && a <= c ? left : b <= c ? up : upLeft;
}

/** A PNG whose rows are filtered with `filters[y]`, written by hand: the decoder must undo every kind. */
function pngWithFilters(source: RgbaImage, filters: number[], channels: 3 | 4 = 4): Buffer {
  const stride = source.width * channels;
  const raw = Buffer.alloc((stride + 1) * source.height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < source.height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < source.width; x++) {
      for (let c = 0; c < channels; c++) {
        row[x * channels + c] = source.pixels[(y * source.width + x) * 4 + c];
      }
    }
    raw[y * (stride + 1)] = filters[y];
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filters[y]];
      raw[y * (stride + 1) + 1 + i] = (row[i] - predicted) & 0xff;
    }
    previous = row;
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(source.width, 0);
  header.writeUInt32BE(source.height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('decodePng', () => {
  it('undoes every scanline filter', () => {
    const decoded = decodePng(pngWithFilters(gradient, [0, 1, 2, 3, 4]));
    expect(decoded).toEqual(gradient);
  });

  it('reads RGB as opaque RGBA', () => {
    const decoded = decodePng(pngWithFilters(gradient, [4, 3, 2, 1, 0], 3))!;
    expect(decoded.width).toBe(7);
    for (let i = 0; i < decoded.pixels.length; i += 4) {
      expect([...decoded.pixels.subarray(i, i + 3)]).toEqual([...gradient.pixels.subarray(i, i + 3)]);
      expect(decoded.pixels[i + 3]).toBe(255);
    }
  });

  it('declines what it does not read, rather than guessing', () => {
    const sixteenBit = pngWithFilters(gradient, [0, 0, 0, 0, 0]);
    sixteenBit[8 + 8 + 8] = 16; // IHDR bit depth
    expect(decodePng(sixteenBit)).toBeNull();
    expect(decodePng(Buffer.from('not a png'))).toBeNull();
    expect(decodePng(pngWithFilters(gradient, [0, 0, 9, 0, 0]))).toBeNull();
  });
});

describe('encodePng', () => {
  it('round-trips through the decoder', () => {
    expect(decodePng(encodePng(gradient))).toEqual(gradient);
  });

  it('crops exactly the rectangle asked for', () => {
    const cropped = cropImage(gradient, { x: 2, y: 1, width: 3, height: 2 });
    expect(cropped.width).toBe(3);
    expect([...cropped.pixels.subarray(0, 4)]).toEqual([...gradient.pixels.subarray((1 * 7 + 2) * 4, (1 * 7 + 2) * 4 + 4)]);
    expect(decodePng(encodePng(cropped))).toEqual(cropped);
  });
});

describe('trimToModel', () => {
  it('cuts a transparent border down to the model plus the margin', () => {
    const size = 100;
    const model = image(size, size, (x, y) => (x >= 40 && x < 50 && y >= 30 && y < 70 ? [200, 100, 50, 255] : [0, 0, 0, 0]));
    const trimmed = decodePng(trimToModel(encodePng(model))!)!;
    // 10 × 40 of model, 16 px of margin each side, clamped to the picture.
    expect({ width: trimmed.width, height: trimmed.height }).toEqual({ width: 42, height: 72 });
  });

  it('keeps nothing of a blank capture, and a picture it cannot read as it came', () => {
    expect(trimToModel(encodePng(image(8, 8, () => [0, 0, 0, 0])))).toBeNull();
    expect(trimToModel(Buffer.alloc(0))).toBeNull();
    const unreadable = Buffer.from('not a png');
    expect(trimToModel(unreadable)).toBe(unreadable);
  });
});
