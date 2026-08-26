import { describe, it, expect } from 'vitest';
import { angleLabelPlacement } from '../src/sketch-solver-client/angle-label';

// ---------------------------------------------------------------------------
// The angle readout's adaptive placement is pure sector math (px), so
// everything here is plain numbers: no camera, no Three, no DOM.
//
// Sizes mirror the real readout: ANGLE_LABEL_PX_SIZE 22 (half-height 11) and
// a "26.54°" texture roughly 2.3× as wide as it is tall (half-width 25), at
// the committed glyph's base radius of 48 px.
// ---------------------------------------------------------------------------

const HW = 25;
const HH = 11;
const BASE = 48;
const ARC = 26;

const deg = (d: number): number => (d * Math.PI) / 180;

/** Signed distance from a point at (angle, radius) to the line through the
 * origin along `rayAngle` — the clearance the label box must beat. */
function distanceToRayLine(pointAngle: number, radiusPx: number, rayAngle: number): number {
  return Math.abs(radiusPx * Math.sin(pointAngle - rayAngle));
}

/** Support radius of the box against a ray at `theta` (see angle-label.ts). */
function support(theta: number): number {
  return HW * Math.abs(Math.sin(theta)) + HH * Math.abs(Math.cos(theta));
}

describe('angle label placement', () => {
  it('keeps a comfortable angle at the base radius on the bisector', () => {
    const placed = angleLabelPlacement(deg(-45), deg(90), HW, HH, BASE, ARC);
    expect(placed.outside).toBe(false);
    expect(placed.radiusPx).toBe(BASE);
    expect(placed.angle).toBeCloseTo(0, 9);
    expect(placed.arcRadiusPx).toBe(ARC);
  });

  it('pushes a narrow angle out along the bisector until the box clears both rays', () => {
    // The reported case: a ~26.5° wedge opening leftward — at the base
    // radius the label box overlapped both dashed rays.
    const start = deg(180 - 13.27);
    const sweep = deg(26.54);
    const placed = angleLabelPlacement(start, sweep, HW, HH, BASE, ARC);
    expect(placed.outside).toBe(false);
    expect(placed.angle).toBeCloseTo(start + sweep / 2, 9);
    expect(placed.radiusPx).toBeGreaterThan(BASE);
    for (const ray of [start, start + sweep]) {
      expect(distanceToRayLine(placed.angle, placed.radiusPx, ray))
        .toBeGreaterThanOrEqual(support(ray) + 4);
    }
    // The arc follows the label out — ending short of its box, never past it.
    expect(placed.arcRadiusPx).toBeGreaterThan(ARC);
    expect(placed.arcRadiusPx).toBeLessThan(placed.radiusPx - HW);
  });

  it('grows the radius no further than the fit demands', () => {
    const start = deg(-15);
    const sweep = deg(30);
    const placed = angleLabelPlacement(start, sweep, HW, HH, BASE, ARC);
    // Shrinking the placed radius by a few px must break a clearance —
    // otherwise the label is drifting further from its arc than needed.
    const shrunk = placed.radiusPx - 8;
    const clears = [start, start + sweep].every(
      ray => distanceToRayLine(placed.angle, shrunk, ray) >= support(ray) + 4,
    );
    expect(clears).toBe(false);
  });

  it('moves a sliver angle outside the wedge, beside the arc, clear of the near ray', () => {
    const start = deg(0);
    const sweep = deg(4);
    const placed = angleLabelPlacement(start, sweep, HW, HH, BASE, ARC);
    expect(placed.outside).toBe(true);
    expect(placed.radiusPx).toBe(BASE);
    expect(placed.arcRadiusPx).toBe(ARC);
    // Outside the sector…
    const inSector = placed.angle > start && placed.angle < start + sweep;
    expect(inSector).toBe(false);
    // …but still hugging it (within a quadrant of the near ray).
    const offStart = Math.abs(placed.angle - start);
    const offEnd = Math.abs(placed.angle - (start + sweep));
    expect(Math.min(offStart, offEnd)).toBeLessThan(Math.PI / 2);
    // And its box clears the ray it sits beside.
    const near = offStart < offEnd ? start : start + sweep;
    expect(distanceToRayLine(placed.angle, placed.radiusPx, near))
      .toBeGreaterThanOrEqual(support(near) + 4);
  });

  it('never leaves the base radius for a wide-open angle', () => {
    for (const sweepDeg of [120, 179, 220, 300]) {
      const placed = angleLabelPlacement(deg(10), deg(sweepDeg), HW, HH, BASE, ARC);
      expect(placed.outside).toBe(false);
      expect(placed.radiusPx).toBe(BASE);
    }
  });

  it('is orientation-aware: rays the box lies along need less clearance than rays it crosses', () => {
    // Same sweep, two orientations. Opening along +x: the box runs parallel
    // to near-horizontal rays (support ≈ half-height). Opening along +y: the
    // box crosses near-vertical rays (support ≈ half-width), so the same
    // wedge must push the label further out.
    const flat = angleLabelPlacement(deg(-20), deg(40), HW, HH, BASE, ARC);
    const steep = angleLabelPlacement(deg(70), deg(40), HW, HH, BASE, ARC);
    expect(flat.outside).toBe(false);
    expect(steep.outside).toBe(false);
    expect(steep.radiusPx).toBeGreaterThan(flat.radiusPx);
  });
});
