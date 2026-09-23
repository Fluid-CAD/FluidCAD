import { describe, expect, it } from 'vitest';
import { opaqueBounds, padRect } from '../src/thumbnail-bounds';

/** A width × height RGBA bitmap, transparent except the listed pixels. */
function bitmap(width: number, height: number, opaque: Array<[number, number, number?]>): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (const [x, y, alpha = 255] of opaque) {
    pixels[(y * width + x) * 4 + 3] = alpha;
  }
  return pixels;
}

describe('opaqueBounds', () => {
  it('is the tight box around the opaque pixels', () => {
    const pixels = bitmap(10, 8, [[2, 1], [7, 1], [4, 6]]);
    expect(opaqueBounds(pixels, 10, 8)).toEqual({ x: 2, y: 1, width: 6, height: 6 });
  });

  it('ignores the anti-aliased fringe', () => {
    const pixels = bitmap(10, 8, [[0, 0, 3], [5, 5], [9, 7, 8]]);
    expect(opaqueBounds(pixels, 10, 8)).toEqual({ x: 5, y: 5, width: 1, height: 1 });
  });

  it('is null for a blank capture', () => {
    expect(opaqueBounds(bitmap(4, 4, []), 4, 4)).toBeNull();
  });
});

describe('padRect', () => {
  it('grows by the margin on every side', () => {
    expect(padRect({ x: 10, y: 10, width: 5, height: 5 }, 4, 100, 100)).toEqual({ x: 6, y: 6, width: 13, height: 13 });
  });

  it('stays inside the bitmap', () => {
    expect(padRect({ x: 1, y: 2, width: 98, height: 5 }, 4, 100, 10)).toEqual({ x: 0, y: 0, width: 100, height: 10 });
  });
});
