import { describe, expect, it } from "vitest";
import { Face } from "../../common/face.js";
import { Wire } from "../../common/wire.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { transformHelixGeometry } from "../../math/helix-geometry.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { getOC } from "../../oc/init.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { SweepOps } from "../../oc/sweep-ops.js";
import { resolveSweepSpec } from "../../oc/sweep/sweep-spec.js";
import { WireExtendOps } from "../../oc/wire-extend-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { boundaryError, orientationFixture, screwPoint, SECTION_TOLERANCE, TRAPEZOID } from "../helpers/sweep-orientation.js";
import helix from "../../core/helix.js";
import copy from "../../core/copy.js";
import select from "../../core/select.js";
import plane from "../../core/plane.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import { circle, line } from "../../core/2d/index.js";
import { coincident, diameter, fix } from "../../core/constraints/index.js";
import { edge } from "../../filters/index.js";
import type { SceneObject } from "../../common/scene-object.js";
import type { Sweep } from "../../features/sweep.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { render, setupOC } from "../setup.js";

describe("cylindrical sweep path provenance and placement", () => {
  const translation = Matrix4.fromTranslation(41, -26, 13);
  const rotation = Matrix4.fromRotationAroundAxis(Point.origin(), new Vector3d(1, 2, -3).normalize(), 1.2);
  const reflection = Matrix4.mirrorPlane(Vector3d.unitX(), new Point(7, 0, 0));

  it.each([
    ["translated", translation], ["rotated", rotation], ["mirrored", reflection],
    ["reversed axis", Matrix4.mirrorPlane(Vector3d.unitZ(), Point.origin())],
    ["rotated and mirrored", translation.multiply(rotation).multiply(reflection)],
  ] as const)("keeps the actual cutter correct on a %s selected copy", (_, matrix) => {
    const f = orientationFixture(28, 1.25);
    const path = ShapeOps.transform(f.wire, matrix) as Wire;
    const face = ShapeOps.transform(f.automatic.profileFaces[0], matrix) as Face;
    const selected = Explorer.findEdgesWrapped(path);
    const wire = WireOps.makeWireFromEdges(selected);
    // Descriptors own their native references; selections outlive wrappers.
    path.dispose();
    selected.forEach(edge => edge.dispose());
    try {
      const spec = resolveSweepSpec(wire, [face]);
      expect(spec.transport.kind).toBe("helix");
      if (spec.transport.kind !== "helix") throw new Error("Missing copied path descriptor");
      expect(spec.transport.geometry.winding).toBe(matrix.determinant() < 0 ? 1 : -1);
      const result = SweepOps.buildResolved(spec);
      try {
        expect(result.solids).toHaveLength(1);
        expect(ShapeValidator.validate(result.solids[0].getShape()).findings).toEqual([]);
        expect(boundaryError(f, result.solids[0].getShape(), matrix)).toBeLessThanOrEqual(SECTION_TOLERANCE);
      } finally {
        result.solids.forEach(s => s.dispose()); result.firstShape.delete(); result.lastShape.delete();
      }
    } finally {
      face.dispose(); wire.dispose(); f.dispose();
    }
  });

  it.each([0, 0.37, 0.5, 1])("preserves the drawn section at authored fraction %s", fraction => {
    const f = orientationFixture(28, 1.25);
    const { geometry } = f;
    const matrix = Matrix4.fromTranslation(0, 0, (geometry.zEnd - geometry.zStart) * fraction).multiply(
      Matrix4.fromRotationAroundAxis(Point.origin(), Vector3d.unitZ(), geometry.winding * geometry.parameterEnd * fraction),
    );
    const face = ShapeOps.transform(f.automatic.profileFaces[0], matrix) as Face;
    const plane = f.plane.applyMatrix(matrix);
    plane.pathStation = { point: matrix.transformPoint(f.plane.origin), tangent: plane.normal.negate() };
    try {
      const spec = resolveSweepSpec(f.wire, [face], { profilePlane: plane });
      const result = SweepOps.buildResolved(spec);
      try {
        expect(ShapeValidator.validate(result.solids[0].getShape()).findings).toEqual([]);
        expect(boundaryError(f, result.solids[0].getShape())).toBeLessThanOrEqual(SECTION_TOLERANCE);
      } finally {
        result.solids.forEach(s => s.dispose()); result.firstShape.delete(); result.lastShape.delete();
      }
    } finally { face.dispose(); f.dispose(); }
  });

  it("preserves a section with the opposite face normal", () => {
    const f = orientationFixture(28, 1.25);
    const raw = f.automatic.profileFaces[0].getShape().Reversed();
    const face = Face.fromTopoDSFace(getOC().TopoDS.Face(raw));
    try {
      const result = SweepOps.makeSweep(f.wire, [face]);
      try {
        expect(boundaryError(f, result.solids[0].getShape())).toBeLessThanOrEqual(SECTION_TOLERANCE);
      } finally {
        result.solids.forEach(s => s.dispose()); result.firstShape.delete(); result.lastShape.delete();
      }
    } finally { face.dispose(); raw.delete(); f.dispose(); }
  });

  it.each(["start", "end", "both"])("carries the helical frame onto tangent extensions at %s", side => {
    const f = orientationFixture(28, 1.25);
    const extended: Wire[] = [];
    let wire = f.wire;
    if (side !== "end") extended.push(wire = WireExtendOps.extendWire(wire, "start", 7));
    if (side !== "start") extended.push(wire = WireExtendOps.extendWire(wire, "end", 9));
    f.plane.pathStation = { point: f.plane.origin, tangent: f.plane.normal.negate() };
    try {
      const spec = resolveSweepSpec(wire, f.automatic.profileFaces, { profilePlane: f.plane });
      expect(spec.transport.kind).toBe("helix");
      const result = SweepOps.buildResolved(spec);
      try {
        expect(ShapeValidator.validate(result.solids[0].getShape()).findings).toEqual([]);
        expect(boundaryError(f, result.solids[0].getShape())).toBeLessThanOrEqual(SECTION_TOLERANCE);
        const edge = f.wire.getEdges()[0];
        const startTangent = EdgeOps.getEdgeTangentAtStartRaw(edge.getShape());
        const endTangent = EdgeOps.getEdgeTangentAtEndRaw(edge.getShape());
        const first = Face.fromTopoDSFace(getOC().TopoDS.Face(result.firstShape));
        const last = Face.fromTopoDSFace(getOC().TopoDS.Face(result.lastShape));
        try {
          for (const point of f.points) {
            const atStart = point.add(startTangent.multiply(side === "end" ? 0 : -7));
            const atEnd = screwPoint(f, point, 1).add(endTangent.multiply(side === "start" ? 0 : 9));
            expect(EdgeOps.distancePointToEdge(atStart, first)).toBeLessThanOrEqual(SECTION_TOLERANCE);
            expect(EdgeOps.distancePointToEdge(atEnd, last)).toBeLessThanOrEqual(SECTION_TOLERANCE);
          }
        } finally { first.dispose(); last.dispose(); }
      } finally {
        result.solids.forEach(s => s.dispose()); result.firstShape.delete(); result.lastShape.delete();
      }
    } finally { extended.forEach(w => w.dispose()); f.dispose(); }
  });

  it("reverses a selected path without changing its helix descriptor", () => {
    const f = orientationFixture(28, 1.25);
    const wire = WireOps.reverseWire(f.wire);
    f.plane.pathStation = { point: f.plane.origin, tangent: f.plane.normal.negate() };
    try {
      const result = SweepOps.makeSweep(wire, [...f.automatic.profileFaces], f.plane);
      try {
        expect(boundaryError(f, result.solids[0].getShape())).toBeLessThanOrEqual(SECTION_TOLERANCE);
      } finally {
        result.solids.forEach(s => s.dispose()); result.firstShape.delete(); result.lastShape.delete();
      }
    } finally { wire.dispose(); f.dispose(); }
  });

  it("invalidates an analytic descriptor for nonuniform scaling", () => {
    const f = orientationFixture();
    try {
      const matrix = new Matrix4([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      expect(transformHelixGeometry(f.geometry, matrix)).toBeNull();
    } finally { f.dispose(); }
  });

  it("uses corrected Frenet for an untagged imported spatial path", () => {
    const f = orientationFixture(10, 32);
    const raw = f.wire.getShape().Oriented(f.wire.getShape().Orientation());
    const wire = Wire.fromTopoDSWire(getOC().TopoDS.Wire(raw));
    try {
      expect(resolveSweepSpec(wire, f.automatic.profileFaces).transport.kind).toBe("correctedFrenet");
    } finally { wire.dispose(); raw.delete(); f.dispose(); }
  });
});

describe("selected helix copy cache rebuilds", () => {
  setupOC();

  it("includes standalone curves only when a filter explicitly names their source", () => {
    const path = helix("z").radius(25).pitch(28).turns(1.25);
    const all = select(edge()) as unknown as SceneObject;
    const selected = select(edge().from(path)) as unknown as SceneObject;
    render();
    expect(all.getShapes()).toHaveLength(0);
    expect(selected.getShapes()).toHaveLength(1);
    expect(selected.getShapes()[0].getHelixEdges()).toHaveLength(1);
  });

  it.each([false, true])("keeps interior profile wall classification after placement (thin=%s)", thin => {
    const path = helix("z").radius(25).pitch(28).turns(1.25);
    const profile = sketch(plane(path, 0.37), () => {
      if (thin) {
        const segment = line([-2, 0], [2, 0]);
        fix(segment.start(), [-2, 0]); fix(segment.end(), [2, 0]);
      } else {
        for (const size of [4, 2]) {
          const c = circle([0, 0], size);
          fix(c.center(), [0, 0]); diameter(c, size);
        }
      }
    });
    const feature = sweep(path, profile).new() as Sweep;
    if (thin) feature.thin(1);
    render();
    expect(feature.getError()).toBeNull();
    expect(ShapeValidator.validate(feature.getShapes()[0].getShape()).findings).toEqual([]);
    // The 1.25-turn path now has two bounded spans. Every span must inherit
    // the same wall role, including the ones not adjacent to the start cap.
    expect(feature.getState("side-faces")).toHaveLength(2);
    expect(feature.getState("internal-faces")).toHaveLength(2);
    expect(feature.getState("cap-faces")).toHaveLength(thin ? 4 : 0);
  });

  function build(pitch: number) {
    const h = helix("z").radius(25).pitch(pitch).turns(1.25);
    const copies = copy("linear", "x", { count: 2, offset: 70 }, h);
    const path = select(edge().from(copies).farthest("x")) as unknown as SceneObject;
    const profile = sketch(plane(path, 0.37), () => {
      const edges = TRAPEZOID.map((p, i) => line(p, TRAPEZOID[(i + 1) % 4]));
      edges.forEach((line, i) => {
        fix(line.start(), TRAPEZOID[i]);
        coincident(line.end(), edges[(i + 1) % 4].start());
      });
    });
    const feature = sweep(path, profile).new() as Sweep;
    return { path, feature };
  }

  it("retains provenance on cache reuse and replaces it after a pitch edit", () => {
    const first = build(28);
    let previous = render();
    expect(previous.getAllSceneObjects().filter(o => o.getError()).map(o => `${o.getType()}: ${o.getError()}`)).toEqual([]);
    const initial = first.path.getAddedShapes()[0];
    const firstVolume = ShapeValidator.signedVolume(first.feature.getShapes()[0].getShape());
    for (const pitch of [28, 40]) {
      const next = getSceneManager().startScene();
      build(pitch);
      SceneCompare.compare(previous, next);
      previous = render();
      expect(previous.getAllSceneObjects().filter(o => o.getError()).map(o => `${o.getType()}: ${o.getError()}`)).toEqual([]);
      // Read recorded input shapes even after the sweep consumes the selection.
      const path = previous.getAllSceneObjects().find(o => o.getType() === "select")!;
      const feature = previous.getAllSceneObjects().find(o => o.getType() === "sweep")!;
      const descriptor = path.getAddedShapes()[0].getHelixEdges()[0].geometry;
      expect(descriptor.frame.origin.x).toBeCloseTo(70, 8);
      expect((descriptor.zEnd - descriptor.zStart) / descriptor.turns).toBe(pitch);
      if (pitch === 28) {
        expect(path.getAddedShapes()[0].getShape().IsSame(initial.getShape())).toBe(true);
        expect(ShapeValidator.signedVolume(feature.getShapes()[0].getShape())).toBeCloseTo(firstVolume, 6);
      } else {
        expect(initial.isReleased()).toBe(true);
      }
      expect(ShapeValidator.validate(feature.getShapes()[0].getShape()).findings).toEqual([]);
    }
  });
});
