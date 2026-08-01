import { describe, it, expect } from "vitest";
import {
  buildCircularGhostMatrices, buildLinearGhostMatrices, buildMirrorGhostMatrices,
  buildRotateGhostMatrices, linearGhostInstanceCount, RepeatGhostDirection,
} from "../../features/repeat-ghost.js";
import { Axis } from "../../math/axis.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

/** Where a probe point ends up under each instance transform. */
function places(matrices: Matrix4[], probe = new Point(0, 0, 0)): number[][] {
  return matrices.map(m => {
    const p = m.transformPoint(probe);
    return [round(p.x), round(p.y), round(p.z)];
  });
}

/** Rounded to the micron, and never a negative zero (`-0 + 0` is `+0`). */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0;
}

function direction(
  axis: Axis,
  count: number,
  offset: number,
): RepeatGhostDirection {
  return { axis, count, offset };
}

describe("repeat ghost instances", () => {
  describe("linear", () => {
    it("places every instance but the original", () => {
      const matrices = buildLinearGhostMatrices([direction(Axis.X(), 3, 40)], false);

      expect(places(matrices)).toEqual([[40, 0, 0], [80, 0, 0]]);
    });

    it("lays out the grid two directions describe", () => {
      const matrices = buildLinearGhostMatrices(
        [direction(Axis.X(), 2, 40), direction(Axis.Y(), 3, 10)],
        false,
      );

      // 2 × 3 cells, the origin corner left to the geometry already on screen.
      expect(places(matrices)).toEqual([
        [0, 10, 0], [0, 20, 0],
        [40, 0, 0], [40, 10, 0], [40, 20, 0],
      ]);
    });

    it("centers the pattern on the original", () => {
      const matrices = buildLinearGhostMatrices([direction(Axis.X(), 3, 40)], true);

      expect(places(matrices)).toEqual([[-40, 0, 0], [40, 0, 0]]);
    });

    it("walks a direction that holds a single instance", () => {
      const matrices = buildLinearGhostMatrices(
        [direction(Axis.X(), 3, 40), direction(Axis.Y(), 1, 0)],
        false,
      );

      expect(places(matrices)).toEqual([[40, 0, 0], [80, 0, 0]]);
    });

    it("follows the axis it is given, not the world's", () => {
      const diagonal = new Axis(new Point(0, 0, 0), new Vector3d(0, 0.6, 0.8));
      const matrices = buildLinearGhostMatrices([direction(diagonal, 2, 10)], false);

      expect(places(matrices)).toEqual([[0, 6, 8]]);
    });

    it("draws nothing while the numbers are still being typed", () => {
      // A lone instance, a spacing at zero, a count that isn't whole — every
      // one is a state the dialog passes through on the way somewhere.
      expect(buildLinearGhostMatrices([direction(Axis.X(), 1, 40)], false)).toEqual([]);
      expect(buildLinearGhostMatrices([direction(Axis.X(), 3, 0)], false)).toEqual([]);
      expect(buildLinearGhostMatrices([direction(Axis.X(), 2.5, 40)], false)).toEqual([]);
      expect(buildLinearGhostMatrices([direction(Axis.X(), 3, NaN)], false)).toEqual([]);
      expect(buildLinearGhostMatrices([], false)).toEqual([]);
    });

    it("draws nothing along a degenerate axis", () => {
      const nowhere = new Axis(new Point(0, 0, 0), new Vector3d(0, 0, 0));

      expect(buildLinearGhostMatrices([direction(nowhere, 3, 40)], false)).toEqual([]);
    });
  });

  describe("circular", () => {
    const probe = new Point(10, 0, 0);

    it("divides a full circle by the count", () => {
      const matrices = buildCircularGhostMatrices(
        Axis.Z(), 4, { mode: 'angle', value: 360 }, false,
      );

      // 90° apart — the fourth instance would land back on the original.
      expect(places(matrices, probe)).toEqual([[0, 10, 0], [-10, 0, 0], [0, -10, 0]]);
    });

    it("divides a partial sweep by the gaps", () => {
      const matrices = buildCircularGhostMatrices(
        Axis.Z(), 4, { mode: 'angle', value: 90 }, false,
      );

      // 90° spanned by 4 instances = 30° steps, the last one AT 90°.
      expect(places(matrices, probe)[2]).toEqual([0, 10, 0]);
      expect(matrices).toHaveLength(3);
    });

    it("takes a per-neighbour step verbatim", () => {
      const matrices = buildCircularGhostMatrices(
        Axis.Z(), 3, { mode: 'offset', value: 45 }, false,
      );

      const [x, y, z] = places(matrices, probe)[0];
      expect(x).toBeCloseTo(7.071, 3);
      expect(y).toBeCloseTo(7.071, 3);
      expect(z).toBeCloseTo(0, 6);
      expect(matrices).toHaveLength(2);
    });

    it("centers the pattern by starting half a turn back", () => {
      const matrices = buildCircularGhostMatrices(
        Axis.Z(), 4, { mode: 'angle', value: 360 }, true,
      );

      // start = -(4 × 90) / 2 = -180, so the clones sit at -90°, 0° and 90°:
      // the kernel shifts the clones alone and leaves the original in place
      // (repeat.ts:235-245), and the ghost has to show what the apply builds.
      expect(places(matrices, probe)).toEqual([[0, -10, 0], [10, 0, 0], [0, 10, 0]]);
    });

    it("draws nothing while the numbers are still being typed", () => {
      const sweep = { mode: 'angle' as const, value: 360 };
      expect(buildCircularGhostMatrices(Axis.Z(), 1, sweep, false)).toEqual([]);
      expect(buildCircularGhostMatrices(Axis.Z(), 4, { mode: 'angle', value: 0 }, false)).toEqual([]);
      expect(buildCircularGhostMatrices(Axis.Z(), 4, { mode: 'offset', value: 0 }, false)).toEqual([]);
      expect(buildCircularGhostMatrices(Axis.Z(), 3.5, sweep, false)).toEqual([]);
    });
  });

  describe("mirror", () => {
    it("reflects the one instance across the plane", () => {
      const matrices = buildMirrorGhostMatrices(Plane.XZ());

      expect(matrices).toHaveLength(1);
      expect(places(matrices, new Point(5, 30, 2))).toEqual([[5, -30, 2]]);
    });

    it("reflects across an offset plane", () => {
      const matrices = buildMirrorGhostMatrices(Plane.XY().offset(10));

      expect(places(matrices, new Point(0, 0, 4))).toEqual([[0, 0, 16]]);
    });
  });

  describe("rotate", () => {
    it("turns a single clone around the axis", () => {
      const matrices = buildRotateGhostMatrices(Axis.Z(), 90);

      expect(places(matrices, new Point(10, 0, 0))).toEqual([[0, 10, 0]]);
    });

    it("draws nothing for a turn that moves the clone nowhere", () => {
      expect(buildRotateGhostMatrices(Axis.Z(), 0)).toEqual([]);
      expect(buildRotateGhostMatrices(Axis.Z(), 360)).toEqual([]);
      expect(buildRotateGhostMatrices(Axis.Z(), NaN)).toEqual([]);
    });
  });

  describe("instance count", () => {
    it("reads the grid size off the counts alone", () => {
      expect(linearGhostInstanceCount([{ count: 3 }])).toBe(2);
      expect(linearGhostInstanceCount([{ count: 20 }, { count: 20 }])).toBe(399);
      expect(linearGhostInstanceCount([{ count: 1 }])).toBe(0);
      expect(linearGhostInstanceCount([])).toBe(0);
    });
  });
});
