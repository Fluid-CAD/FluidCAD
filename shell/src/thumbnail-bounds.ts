/**
 * Pixel-space bounds for the start-screen previews: pure over a bitmap's
 * bytes, so it is testable without Electron (which is what turns a PNG into
 * one, see `thumbnails.ts`).
 */

export type PixelRect = { x: number; y: number; width: number; height: number };

/** Alpha at or below this is "empty": anti-aliased fringe, not model. */
const OPAQUE_ALPHA = 8;

/**
 * The smallest rectangle holding every pixel of a 4-bytes-per-pixel bitmap
 * (BGRA or RGBA — only the alpha byte is read) that is not transparent, or
 * null when the whole bitmap is.
 */
export function opaqueBounds(pixels: Uint8Array, width: number, height: number): PixelRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] > OPAQUE_ALPHA) {
        if (x < minX) { minX = x; }
        if (x > maxX) { maxX = x; }
        if (y < minY) { minY = y; }
        if (y > maxY) { maxY = y; }
      }
    }
  }
  if (maxX < 0) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** `rect` grown by `margin` on every side, kept inside a `width` × `height` bitmap. */
export function padRect(rect: PixelRect, margin: number, width: number, height: number): PixelRect {
  const x = Math.max(0, rect.x - margin);
  const y = Math.max(0, rect.y - margin);
  const right = Math.min(width, rect.x + rect.width + margin);
  const bottom = Math.min(height, rect.y + rect.height + margin);
  return { x, y, width: right - x, height: bottom - y };
}
