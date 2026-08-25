import { describe, it, expect } from 'vitest';
import { insideGlyphBox } from '../src/meshes/containers/glyph-box';
import type { GlyphBox } from '../src/meshes/containers/glyph-box';

// ---------------------------------------------------------------------------
// The glyph pick box is pure screen math (px, y down), so everything here is
// plain numbers: no camera, no Three, no DOM.
//
// Sizes mirror a real diameter readout: LABEL_PX_SIZE 22 (half-height 11) and
// a "⌀20.00" texture roughly 2.2× as wide as it is tall (half-width 24).
// ---------------------------------------------------------------------------

const DIAMETER_LABEL: GlyphBox = { halfWidthPx: 24, halfHeightPx: 11, roll: 0 };

/** Screen offset `distance` px along a direction `deg` below the +x axis. */
function at(deg: number, distance: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a) * distance, Math.sin(a) * distance];
}

describe('glyph pick box', () => {
  it('is the plain screen box while the glyph is unrolled', () => {
    const box = DIAMETER_LABEL;
    expect(insideGlyphBox(0, 0, box)).toBe(true);
    expect(insideGlyphBox(23.9, 10.9, box)).toBe(true);
    expect(insideGlyphBox(24.1, 0, box)).toBe(false);
    expect(insideGlyphBox(0, 11.1, box)).toBe(false);
  });

  it('adds the slack on every side', () => {
    const box = DIAMETER_LABEL;
    expect(insideGlyphBox(26, 13, box, 3)).toBe(true);
    expect(insideGlyphBox(-26, -13, box, 3)).toBe(true);
    expect(insideGlyphBox(27.5, 0, box, 3)).toBe(false);
  });

  it('follows the label when it rolls to lie along its dimension line', () => {
    // A chord running down-right at 45°: screen dir (0.707, 0.707), whose
    // roll is -45° (the layout's rollFor negates screen y).
    const box: GlyphBox = { ...DIAMETER_LABEL, roll: -Math.PI / 4 };
    // 20 px down the label's own long axis is still on the label...
    expect(insideGlyphBox(...at(45, 20), box)).toBe(true);
    // ...while 20 px across it (perpendicular, up-right) is not.
    expect(insideGlyphBox(...at(-45, 20), box)).toBe(false);
    // The two boxes genuinely disagree, and each way round: the unrolled box
    // misses what lies down the rolled label, and claims 20 px of blank
    // screen to its right.
    expect(insideGlyphBox(...at(45, 20), DIAMETER_LABEL)).toBe(false);
    expect(insideGlyphBox(20, 0, DIAMETER_LABEL)).toBe(true);
    expect(insideGlyphBox(20, 0, box)).toBe(false);
  });

  it('gives up the screen-axis corners a rolled label never covers', () => {
    const box: GlyphBox = { ...DIAMETER_LABEL, roll: -Math.PI / 4 };
    // Axis-aligned bounds of the rolled box: cos45 * (24 + 11) ≈ 24.7 each
    // way, so its corner is ~24 px right and ~24 px DOWN of center — inside
    // the bounds the declutterer reserves, and blank screen to the eye.
    expect(insideGlyphBox(24, -24, box)).toBe(false);
    expect(insideGlyphBox(-24, 24, box)).toBe(false);
  });

  it('rolls symmetrically — a label reads the same from either end', () => {
    for (const roll of [-Math.PI / 3, -Math.PI / 4, 0, Math.PI / 6, Math.PI / 2]) {
      const box: GlyphBox = { ...DIAMETER_LABEL, roll };
      for (const [dx, dy] of [[7, 3], [19, -9], [24, 11], [-30, 2]] as const) {
        expect(insideGlyphBox(dx, dy, box)).toBe(insideGlyphBox(-dx, -dy, box));
      }
    }
  });
});
