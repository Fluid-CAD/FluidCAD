import { describe, it, expect } from "vitest";
import type { TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { ShapeInterference } from "../../oc/shape-interference.js";
import type { WorldBounds } from "../../oc/shape-interference.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import type { Extrude } from "../../features/extrude.js";
import { testRect } from "../helpers/profiles.js";

/** The rendered 20×20×10 box's TopoDS_Solid; asserts the build did not fail. */
function makeBox(): TopoDS_Shape {
  sketch("xy", () => {
    testRect(20, 20);
  });
  const box = extrude(10) as Extrude;
  const scene = render();
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
  const solids = box.getShapes({}, 'solid');
  expect(solids).toHaveLength(1);
  return solids[0].getShape();
}

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

function translated(x: number, y: number, z: number) {
  return { position: { x, y, z }, quaternion: IDENTITY_Q };
}

function expectBounds(bounds: WorldBounds, min: number[], max: number[]): void {
  for (let axis = 0; axis < 3; axis++) {
    expect(bounds.min[axis]).toBeCloseTo(min[axis], 3);
    expect(bounds.max[axis]).toBeCloseTo(max[axis], 3);
  }
}

describe("ShapeInterference", () => {
  setupOC();

  it("bounds a box exactly, and a posed box where its pose puts it", () => {
    const box = makeBox();
    expectBounds(ShapeInterference.bounds(box), [0, 0, 0], [20, 20, 10]);

    const moved = ShapeInterference.pose(box, translated(5, -3, 100));
    try {
      expectBounds(moved.bounds, [5, -3, 100], [25, 17, 110]);
    } finally {
      moved.dispose();
    }

    // A quarter turn about Z swings the box into negative X.
    const half = Math.SQRT1_2;
    const turned = ShapeInterference.pose(box, { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: half, w: half } });
    try {
      expectBounds(turned.bounds, [-20, 0, 0], [0, 20, 10]);
    } finally {
      turned.dispose();
    }
  });

  it("bounds overlap when boxes meet or touch, and not when a gap wider than the tolerance separates them", () => {
    const a: WorldBounds = { min: [0, 0, 0], max: [20, 20, 10] };
    const touching: WorldBounds = { min: [20, 0, 0], max: [40, 20, 10] };
    const apart: WorldBounds = { min: [20.5, 0, 0], max: [40, 20, 10] };
    const overlapping: WorldBounds = { min: [10, 10, 5], max: [30, 30, 15] };
    expect(ShapeInterference.boundsOverlap(a, touching, 0)).toBe(true);
    expect(ShapeInterference.boundsOverlap(a, overlapping, 0)).toBe(true);
    expect(ShapeInterference.boundsOverlap(a, apart, 0.1)).toBe(false);
    expect(ShapeInterference.boundsOverlap(a, apart, 1)).toBe(true);
    expect(ShapeInterference.boundsOverlap(apart, a, 0.1)).toBe(false);
  });

  it("common volume is the overlap of two posed solids, zero for touching and for disjoint ones", () => {
    const box = makeBox();
    const half = ShapeInterference.pose(box, translated(10, 0, 0));
    const touching = ShapeInterference.pose(box, translated(20, 0, 0));
    const apart = ShapeInterference.pose(box, translated(30, 0, 0));
    try {
      expect(ShapeInterference.commonVolume(box, half.shape)).toBeCloseTo(10 * 20 * 10, 3);
      expect(ShapeInterference.commonVolume(box, touching.shape)).toBeCloseTo(0, 6);
      expect(ShapeInterference.commonVolume(box, apart.shape)).toBeCloseTo(0, 6);
      // Symmetric, and a solid against itself is its own volume.
      expect(ShapeInterference.commonVolume(half.shape, box)).toBeCloseTo(2000, 3);
      expect(ShapeInterference.commonVolume(box, box)).toBeCloseTo(4000, 3);
    } finally {
      half.dispose();
      touching.dispose();
      apart.dispose();
    }
  });

  it("the identity pose shares the input shape and its disposer is a no-op", () => {
    const box = makeBox();
    const posed = ShapeInterference.pose(box);
    expect(posed.shape).toBe(box);
    posed.dispose();
    expectBounds(ShapeInterference.bounds(box), [0, 0, 0], [20, 20, 10]);
  });
});
