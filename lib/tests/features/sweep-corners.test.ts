import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import { circle, line, arc } from "../../core/2d/index.js";
import { coincident, horizontal, vertical, tangent, distance, radius } from "../../core/constraints/index.js";
import { testRect } from "../helpers/profiles.js";
import { Sweep } from "../../features/sweep.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { FaceQuery } from "../../oc/face-query.js";
import { SweepOps } from "../../oc/sweep-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { FaceMaker2 } from "../../oc/face-maker2.js";
import { Explorer } from "../../oc/explorer.js";
import { Point } from "../../math/point.js";
import { Sketch } from "../../features/2d/sketch.js";
import type { Shape } from "../../common/shape.js";

/** Volume of a mitred pipe: cross-section area × total spine length (exact for line→line mitres). */
const R = 5;
const AREA = Math.PI * R * R;

function solidOf(s: Sweep): Shape {
  const shapes = s.getShapes();
  expect(shapes).toHaveLength(1);
  expect(shapes[0].getType()).toBe("solid");
  expect(ShapeValidator.validate(shapes[0].getShape()).findings).toEqual([]);
  return shapes[0];
}

function volumeOf(shape: Shape): number {
  return ShapeProps.getProperties(shape.getShape()).volumeMm3;
}

function faceTypes(shape: Shape): string[] {
  return shape.getSubShapes("face").map(f => FaceQuery.getSurfaceType(f)).sort();
}

describe("sweep corners", () => {
  setupOC();

  const circleProfile = () => sketch("xy", () => { circle([0, 0], 2 * R); });

  const lPath = () => sketch("xz", () => {
    const l1 = line([0, 0], [0, 50]);
    const l2 = line([0, 50], [50, 50]);
    vertical(l1); horizontal(l2); coincident(l1.end(), l2.start());
  });

  it("mitres a right-angle corner instead of flattening the second leg", () => {
    const profile = circleProfile();
    const path = lPath();
    const s = sweep(path, profile) as Sweep;
    const startFaces = s.startFaces();
    const endFaces = s.endFaces();
    addToScene(startFaces);
    addToScene(endFaces);
    render();
    const solid = solidOf(s);
    expect(volumeOf(solid)).toBeCloseTo(AREA * 100, 0);
    expect(faceTypes(solid)).toEqual(["cylinder", "cylinder", "plane", "plane"]);
    expect(startFaces.getShapes()).toHaveLength(1);
    expect(endFaces.getShapes()).toHaveLength(1);
  });

  it("mitres a rectangular profile exactly", () => {
    const profile = sketch("xy", () => { testRect(20, 12); });
    const path = lPath();
    const s = sweep(path, profile) as Sweep;
    render();
    const solid = solidOf(s);
    // Off-centre rectangle: the mitre keeps area × spine length, halved
    // asymmetrically by the plane but summing to the straight run for each leg
    // measured to the bisector: 240 × (40 + 40).
    expect(volumeOf(solid)).toBeCloseTo(240 * 80, 0);
  });

  it.each([
    ["acute", [30, 20], Math.hypot(30, 30)],
    ["obtuse", [40, 90], Math.hypot(40, 40)],
  ])("mitres an %s corner", (_, end, secondLength) => {
    const profile = circleProfile();
    const path = sketch("xz", () => {
      const l1 = line([0, 0], [0, 50]);
      const l2 = line([0, 50], end as [number, number]);
      vertical(l1); coincident(l1.end(), l2.start());
      distance(l1.start(), l1.end(), 50);
    });
    const s = sweep(path, profile) as Sweep;
    render();
    expect(volumeOf(solidOf(s))).toBeCloseTo(AREA * (50 + secondLength), 0);
  });

  it("carries a corner after a tangent arc without disturbing the arc", () => {
    const profile = circleProfile();
    // Up, a quarter bend to the left (tangent both ends), left, then a sharp turn down.
    const path = sketch("xz", () => {
      const l1 = line([0, 0], [0, 40]);
      const a = arc([0, 40], [-20, 60], [-20, 40]);
      const l2 = line([-20, 60], [-60, 60]);
      const l3 = line([-60, 60], [-60, 20]);
      vertical(l1); horizontal(l2); vertical(l3);
      coincident(l1.end(), a.start()); coincident(a.end(), l2.start()); coincident(l2.end(), l3.start());
      tangent(l1, a); tangent(a, l2);
      radius(a, 20);
      distance(l1.start(), l1.end(), 40); distance(l2.start(), l2.end(), 40); distance(l3.start(), l3.end(), 40);
    });
    const s = sweep(path, profile) as Sweep;
    render();
    const solid = solidOf(s);
    // Straight legs are exact; the arc's tube volume is area × arc length.
    expect(volumeOf(solid)).toBeCloseTo(AREA * (40 + Math.PI * 10 + 40 + 40), 0);
    expect(faceTypes(solid)).toEqual(["cylinder", "cylinder", "cylinder", "plane", "plane", "torus"]);
  });

  it("rounds a corner where a line meets an arc", () => {
    const profile = circleProfile();
    const path = sketch("xz", () => {
      const l1 = line([0, 0], [0, 40]);
      const a = arc([0, 40], [20, 60], [0, 60]);
      vertical(l1); coincident(l1.end(), a.start());
      radius(a, 20); distance(l1.start(), l1.end(), 40);
    });
    const s = sweep(path, profile) as Sweep;
    render();
    const solid = solidOf(s);
    // Line leg + quarter-torus leg, less the wedge where they overlap inside
    // the bend, plus the spherical lune that fills the outside of the bend.
    const legs = AREA * 40 + AREA * Math.PI * 10;
    const lune = Math.PI * R ** 3 / 3;
    expect(volumeOf(solid)).toBeGreaterThan(legs - lune);
    expect(volumeOf(solid)).toBeLessThan(legs + lune);
    expect(faceTypes(solid)).toEqual(["cylinder", "plane", "plane", "sphere", "torus"]);
  });

  it("sweeps a closed rectangular spine into a picture frame", () => {
    const profile = sketch("xy", () => { circle([0, 0], 2 * R); });
    const path = sketch("xz", () => {
      const l1 = line([0, 0], [0, 60]); const l2 = line([0, 60], [60, 60]);
      const l3 = line([60, 60], [60, 0]); const l4 = line([60, 0], [0, 0]);
      vertical(l1); horizontal(l2); vertical(l3); horizontal(l4);
      coincident(l1.end(), l2.start()); coincident(l2.end(), l3.start());
      coincident(l3.end(), l4.start()); coincident(l4.end(), l1.start());
      distance(l1.start(), l1.end(), 60); distance(l2.start(), l2.end(), 60);
    });
    const s = sweep(path, profile) as Sweep;
    render();
    expect(volumeOf(solidOf(s))).toBeCloseTo(AREA * 240, 0);
  });

  it("keeps the bore of a hollow profile through the corner", () => {
    const profile = sketch("xy", () => { circle([0, 0], 2 * R); circle([0, 0], R); });
    const path = lPath();
    const s = sweep(path, profile) as Sweep;
    render();
    const bore = Math.PI * (R / 2) ** 2;
    expect(volumeOf(solidOf(s))).toBeCloseTo((AREA - bore) * 100, 0);
  });

  it("thin-sweeps a wall through the corner", () => {
    const profile = circleProfile();
    const path = lPath();
    const s = sweep(path, profile).thin(1) as Sweep;
    render();
    // Thin offsets the profile outward: the wall spans R..R+1.
    const wall = Math.PI * ((R + 1) ** 2 - R ** 2);
    expect(volumeOf(solidOf(s))).toBeCloseTo(wall * 100, 0);
  });

  it("refuses a segment shorter than its mitres", () => {
    const profile = circleProfile();
    const path = sketch("xz", () => {
      const l1 = line([0, 0], [0, 50]); const l2 = line([0, 50], [4, 50]); const l3 = line([4, 50], [4, 100]);
      vertical(l1); horizontal(l2); vertical(l3);
      coincident(l1.end(), l2.start()); coincident(l2.end(), l3.start());
      distance(l2.start(), l2.end(), 4);
    });
    const s = sweep(path, profile) as Sweep;
    render();
    expect(s.getShapes()).toHaveLength(0);
    expect(s.getError()).toMatch(/too short/);
  });

  it("refuses a path that folds back on itself", () => {
    const profile = circleProfile();
    const path = sketch("xz", () => {
      const l1 = line([0, 0], [0, 50]); const l2 = line([0, 50], [0, 20]);
      vertical(l1); vertical(l2); coincident(l1.end(), l2.start());
      distance(l1.start(), l1.end(), 50); distance(l2.start(), l2.end(), 30);
    });
    const s = sweep(path, profile) as Sweep;
    render();
    expect(s.getShapes()).toHaveLength(0);
    expect(s.getError()).toMatch(/folds back/);
  });

  it("mitres a non-planar polyline with a Frenet frame", () => {
    const profile = circleProfile();
    render();
    const plane = (profile as Sketch).getPlane();
    const face = FaceMaker2.getRegions((profile as Sketch).getGeometries(), plane, false)[0];
    const p = (x: number, y: number, z: number) => new Point(x, y, z);
    const spine = WireOps.makeWireFromEdges([
      EdgeOps.makeLineEdge(p(0, 0, 0), p(0, 0, 50)),
      EdgeOps.makeLineEdge(p(0, 0, 50), p(50, 0, 50)),
      EdgeOps.makeLineEdge(p(50, 0, 50), p(50, 50, 50)),
    ]);
    const result = SweepOps.makeSweep(spine, [face]);
    expect(result.solids).toHaveLength(1);
    const raw = result.solids[0].getShape();
    expect(ShapeValidator.validate(raw).findings).toEqual([]);
    expect(ShapeProps.getProperties(raw).volumeMm3).toBeCloseTo(AREA * 150, 0);
    expect(Explorer.findShapes(raw, Explorer.getOcShapeType("face"))).toHaveLength(5);
  });
});
