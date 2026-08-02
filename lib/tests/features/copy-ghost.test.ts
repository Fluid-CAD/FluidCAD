import { describe, it, expect } from "vitest";
import {
  buildCircularCopyGhostMatrices, buildLinearCopyGhostMatrices,
} from "../../features/copy-ghost.js";
import { buildCircularGhostMatrices } from "../../features/repeat-ghost.js";
import { Axis } from "../../math/axis.js";
import { Matrix4 } from "../../math/matrix4.js";
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

describe("copy ghost instances", () => {
  describe("linear", () => {
    it("places every clone but the original", () => {
      const matrices = buildLinearCopyGhostMatrices(
        [{ axis: Axis.X(), count: 3, offset: 40 }], false,
      );

      expect(places(matrices)).toEqual([[40, 0, 0], [80, 0, 0]]);
    });

    it("lays out the grid two directions describe", () => {
      const matrices = buildLinearCopyGhostMatrices(
        [{ axis: Axis.X(), count: 2, offset: 40 }, { axis: Axis.Y(), count: 3, offset: 10 }],
        false,
      );

      // 2 × 3 cells, the origin corner left to the body already on screen.
      expect(places(matrices)).toEqual([
        [0, 10, 0], [0, 20, 0],
        [40, 0, 0], [40, 10, 0], [40, 20, 0],
      ]);
    });

    it("centers the clones on the original", () => {
      const matrices = buildLinearCopyGhostMatrices(
        [{ axis: Axis.X(), count: 3, offset: 40 }], true,
      );

      expect(places(matrices)).toEqual([[-40, 0, 0], [40, 0, 0]]);
    });

    it("draws nothing while the numbers are still being typed", () => {
      // A lone instance, a spacing at zero, a count that isn't whole — every
      // one is a state the dialog passes through on the way somewhere.
      expect(buildLinearCopyGhostMatrices([{ axis: Axis.X(), count: 1, offset: 40 }], false)).toEqual([]);
      expect(buildLinearCopyGhostMatrices([{ axis: Axis.X(), count: 3, offset: 0 }], false)).toEqual([]);
      expect(buildLinearCopyGhostMatrices([{ axis: Axis.X(), count: 2.5, offset: 40 }], false)).toEqual([]);
      expect(buildLinearCopyGhostMatrices([], false)).toEqual([]);
    });

    it("draws nothing along a degenerate axis", () => {
      const nowhere = new Axis(new Point(0, 0, 0), new Vector3d(0, 0, 0));

      expect(buildLinearCopyGhostMatrices([{ axis: nowhere, count: 3, offset: 40 }], false)).toEqual([]);
    });
  });

  describe("circular", () => {
    const probe = new Point(10, 0, 0);

    it("divides a full circle by the count", () => {
      const matrices = buildCircularCopyGhostMatrices(
        Axis.Z(), 4, { mode: 'angle', value: 360 }, false,
      );

      // 90° apart — the fourth clone would land back on the original.
      expect(places(matrices, probe)).toEqual([[0, 10, 0], [-10, 0, 0], [0, -10, 0]]);
    });

    /** The one rule a copy does NOT share with the repeat (copy-circular.ts:48). */
    it("divides a partial sweep by the count too, unlike a repeat", () => {
      const sweep = { mode: 'angle' as const, value: 90 };
      const copied = buildCircularCopyGhostMatrices(Axis.Z(), 4, sweep, false);
      const repeated = buildCircularGhostMatrices(Axis.Z(), 4, sweep, false);

      // A copy steps 90 / 4 = 22.5°, so the last clone stops at 67.5°, short
      // of the stated span; a repeat spreads the same span over the gaps
      // between its instances and lands on 90°.
      expect(copied).toHaveLength(3);
      const [x, y] = places(copied, probe)[2];
      expect(x).toBeCloseTo(3.827, 3);
      expect(y).toBeCloseTo(9.239, 3);
      expect(places(repeated, probe)[2]).toEqual([0, 10, 0]);
    });

    it("takes a per-neighbour step verbatim", () => {
      const matrices = buildCircularCopyGhostMatrices(
        Axis.Z(), 3, { mode: 'offset', value: 45 }, false,
      );

      const [x, y, z] = places(matrices, probe)[0];
      expect(x).toBeCloseTo(7.071, 3);
      expect(y).toBeCloseTo(7.071, 3);
      expect(z).toBeCloseTo(0, 6);
      expect(matrices).toHaveLength(2);
    });

    it("centers the clones by starting half a turn back", () => {
      const matrices = buildCircularCopyGhostMatrices(
        Axis.Z(), 4, { mode: 'angle', value: 360 }, true,
      );

      // start = -(4 × 90) / 2 = -180, so the clones sit at -90°, 0° and 90°:
      // the kernel shifts the clones alone and leaves the original in place
      // (copy-circular.ts:52-58), and the ghost has to show what the apply builds.
      expect(places(matrices, probe)).toEqual([[0, -10, 0], [10, 0, 0], [0, 10, 0]]);
    });

    it("spins around the axis it is given, not the world's", () => {
      const offAxis = new Axis(new Point(20, 0, 0), new Vector3d(0, 0, 1));
      const matrices = buildCircularCopyGhostMatrices(
        offAxis, 4, { mode: 'angle', value: 360 }, false,
      );

      // 10 mm from the origin is 10 mm the OTHER side of an axis at x = 20.
      expect(places(matrices, probe)[0]).toEqual([20, -10, 0]);
    });

    it("draws nothing while the numbers are still being typed", () => {
      const sweep = { mode: 'angle' as const, value: 360 };
      expect(buildCircularCopyGhostMatrices(Axis.Z(), 1, sweep, false)).toEqual([]);
      expect(buildCircularCopyGhostMatrices(Axis.Z(), 4, { mode: 'angle', value: 0 }, false)).toEqual([]);
      expect(buildCircularCopyGhostMatrices(Axis.Z(), 4, { mode: 'offset', value: 0 }, false)).toEqual([]);
      expect(buildCircularCopyGhostMatrices(Axis.Z(), 3.5, sweep, false)).toEqual([]);
      expect(buildCircularCopyGhostMatrices(
        new Axis(new Point(0, 0, 0), new Vector3d(0, 0, 0)), 4, sweep, false,
      )).toEqual([]);
    });
  });
});
