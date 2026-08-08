import { describe, it, expect } from 'vitest';
import { solveTarcEdgeSnap } from '../src/interactive/drag-move-handler/tarc-edge-snap';
import type { TarcTargetEntry } from '../src/interactive/sketch-edge-utils';

// A tArc(radius, endPoint) end drag from (50, 0) heading +X with radius 40:
// the CCW tangent circle is centered (50, 40) and crosses a vertical line at
// x = 80 at (80, 13.54) and (80, 66.46); the CW circle mirrors below.
const START: [number, number] = [50, 0];
const LEAVE: [number, number] = [1, 0];
const RADIUS = 40;
const THRESHOLD = 5;

function vLineTarget(shapeId: string, x: number, ownerLine = 3): TarcTargetEntry {
  return {
    shapeId,
    ownerLine,
    segments: [{ ax: x, ay: -80, bx: x, by: 80 }],
  };
}

const LOW_Y = 40 - Math.sqrt(40 * 40 - 30 * 30);   // ≈ 13.54
const HIGH_Y = 40 + Math.sqrt(40 * 40 - 30 * 30);  // ≈ 66.46

describe('solveTarcEdgeSnap', () => {
  it('snaps to the first circle-edge intersection along the sweep', () => {
    const snap = solveTarcEdgeSnap(
      START, LEAVE, RADIUS, [79, LOW_Y + 1], [vLineTarget('t1', 80)], THRESHOLD, 10,
    );
    expect(snap).not.toBeNull();
    expect(snap!.shapeId).toBe('t1');
    expect(snap!.sign).toBe(1);
    expect(snap!.point[0]).toBeCloseTo(80, 6);
    expect(snap!.point[1]).toBeCloseTo(LOW_Y, 6);
  });

  it('does not snap at the second intersection — the kernel never reaches it', () => {
    // The cursor sits near the circle's SECOND crossing of the edge; the
    // kernel's solve would stop at the first, so offering a snap here would
    // preview geometry the commit cannot build.
    const snap = solveTarcEdgeSnap(
      START, LEAVE, RADIUS, [79, HIGH_Y - 1], [vLineTarget('t1', 80)], THRESHOLD, 10,
    );
    expect(snap).toBeNull();
  });

  it('writes a negative sign for a clockwise solve', () => {
    const snap = solveTarcEdgeSnap(
      START, LEAVE, RADIUS, [79, -(LOW_Y + 1)], [vLineTarget('t1', 80)], THRESHOLD, 10,
    );
    expect(snap).not.toBeNull();
    expect(snap!.sign).toBe(-1);
    expect(snap!.point[1]).toBeCloseTo(-LOW_Y, 6);
  });

  it('excludes the arc itself and later statements', () => {
    const snap = solveTarcEdgeSnap(
      START, LEAVE, RADIUS, [79, LOW_Y + 1], [vLineTarget('t1', 80, 7)], THRESHOLD, 7,
    );
    expect(snap).toBeNull();
  });

  it('excludes edges touching the arc start', () => {
    const throughStart: TarcTargetEntry = {
      shapeId: 'prev',
      ownerLine: 3,
      segments: [{ ax: 0, ay: 0, bx: 50, by: 0 }],
    };
    const snap = solveTarcEdgeSnap(
      START, LEAVE, RADIUS, [79, LOW_Y + 1], [throughStart], THRESHOLD, 10,
    );
    expect(snap).toBeNull();
  });

  it('ignores edges the fixed-radius circle cannot reach', () => {
    const snap = solveTarcEdgeSnap(
      START, LEAVE, RADIUS, [79, LOW_Y + 1], [vLineTarget('far', 200)], THRESHOLD, 10,
    );
    expect(snap).toBeNull();
  });
});
