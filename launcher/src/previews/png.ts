import zlib from 'zlib';
import type { PixelRect } from './thumbnail-bounds.ts';

/**
 * Just enough PNG to trim a start-screen preview: decode the engine's
 * screenshot to RGBA pixels, and encode a cropped copy. The engine's page
 * produces these with a canvas, which always writes 8-bit, non-interlaced
 * RGBA (or RGB for an opaque canvas); anything else decodes to null and the
 * caller keeps the picture untrimmed.
 *
 * It exists so the previews are made the same way under Electron and plain
 * Node: the desktop app used Electron's `nativeImage`, which `npx fluidcad`
 * does not have.
 */

/** Row-major pixels, four bytes (R, G, B, A) per pixel. */
export type RgbaImage = { width: number; height: number; pixels: Uint8Array };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_RGB = 2;
const COLOR_RGBA = 6;

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
}

/** Undo one scanline's filter in place: `line` holds the filtered bytes on the way in, the raw ones on the way out. */
function unfilter(filter: number, line: Uint8Array, previous: Uint8Array, bytesPerPixel: number): boolean {
  for (let i = 0; i < line.length; i++) {
    const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
    const up = previous[i];
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
    switch (filter) {
      case 0:
        break;
      case 1:
        line[i] = (line[i] + left) & 0xff;
        break;
      case 2:
        line[i] = (line[i] + up) & 0xff;
        break;
      case 3:
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
        break;
      case 4:
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** The pixels of an 8-bit RGB or RGBA PNG, or null for anything this module does not read. */
export function decodePng(png: Uint8Array): RgbaImage | null {
  const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (data.length < SIGNATURE.length || !data.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    return null;
  }
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Buffer[] = [];
  let offset = SIGNATURE.length;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) {
      return null;
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(start);
      height = data.readUInt32BE(start + 4);
      const bitDepth = data[start + 8];
      const colorType = data[start + 9];
      const interlaced = data[start + 12] !== 0;
      channels = colorType === COLOR_RGBA ? 4 : colorType === COLOR_RGB ? 3 : 0;
      if (bitDepth !== 8 || interlaced || channels === 0) {
        return null;
      }
    } else if (type === 'IDAT') {
      compressed.push(data.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (width === 0 || height === 0 || compressed.length === 0) {
    return null;
  }

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(compressed));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    return null;
  }

  const pixels = new Uint8Array(width * height * 4);
  let previous: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const line = new Uint8Array(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    if (!unfilter(raw[rowStart], line, previous, channels)) {
      return null;
    }
    const out = y * width * 4;
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = out + x * 4;
      pixels[to] = line[from];
      pixels[to + 1] = line[from + 1];
      pixels[to + 2] = line[from + 2];
      pixels[to + 3] = channels === 4 ? line[from + 3] : 0xff;
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** `rect` of `image`, as a new image. */
export function cropImage(image: RgbaImage, rect: PixelRect): RgbaImage {
  const pixels = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * image.width + rect.x) * 4;
    pixels.set(image.pixels.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, pixels };
}

/**
 * One scanline filtered each of the five ways, keeping the one whose bytes,
 * read as signed, sum smallest: the heuristic the PNG specification suggests,
 * and what keeps a render's smooth shading small once deflated.
 */
function filterRow(row: Uint8Array, previous: Uint8Array, out: Buffer, at: number): void {
  const bytesPerPixel = 4;
  let bestFilter = 0;
  let bestScore = Infinity;
  const candidate = new Uint8Array(row.length);
  const best = new Uint8Array(row.length);
  for (let filter = 0; filter <= 4; filter++) {
    let score = 0;
    for (let i = 0; i < row.length; i++) {
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const up = previous[i];
      const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      let predicted = 0;
      if (filter === 1) {
        predicted = left;
      } else if (filter === 2) {
        predicted = up;
      } else if (filter === 3) {
        predicted = (left + up) >> 1;
      } else if (filter === 4) {
        predicted = paeth(left, up, upLeft);
      }
      const value = (row[i] - predicted) & 0xff;
      candidate[i] = value;
      score += value < 128 ? value : 256 - value;
    }
    if (score < bestScore) {
      bestScore = score;
      bestFilter = filter;
      best.set(candidate);
    }
  }
  out[at] = bestFilter;
  out.set(best, at + 1);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit RGBA PNG of `image`. */
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  let previous: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < image.height; y++) {
    const row = image.pixels.subarray(y * stride, (y + 1) * stride);
    filterRow(row, previous, raw, y * (stride + 1));
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = COLOR_RGBA;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
