import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { circle, line } from "../../core/2d/index.js";
import { coincident, diameter, fix } from "../../core/constraints/index.js";
import extrude from "../../core/extrude.js";
import helix from "../../core/helix.js";
import plane from "../../core/plane.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import type { Sketch } from "../../features/2d/sketch.js";
import type { Sweep } from "../../features/sweep.js";
import { buildSweepGhostSolids } from "../../features/sweep-ghost.js";
import { CoordinateSystem } from "../../math/coordinate-system.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { getOC } from "../../oc/init.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { SweepOps, type SweepResult } from "../../oc/sweep-ops.js";
import { getSceneManager } from "../../scene-manager.js";
import { render } from "../setup.js";
import {
  analyticRemovedVolume, boundaryError, orientationFixture, sectionMetrics,
  ROLL_TOLERANCE_DEG, SECTION_TOLERANCE, TRAPEZOID,
  type OrientationFixture,
} from "../helpers/sweep-orientation.js";

function disposeSweep(result: SweepResult) {
  result.firstShape.delete();
  result.lastShape.delete();
  result.solids.forEach(s => s.dispose());
}

describe("subtractive cylindrical sweep release gate", () => {
  let fixture: OrientationFixture;
  let automatic: SweepResult;
  let axial: SweepResult;
  let legacyMetrics: ReturnType<typeof sectionMetrics>;
  let legacyBoundaryError: number;

  // Build outside it.fails: a kernel/fixture error must fail setup, never
  // masquerade as the expected geometric defect. Remove .fails as each
  // automatic-policy gate is fixed; an unexpected pass already fails CI.
  beforeAll(() => {
    fixture = orientationFixture();
    legacyMetrics = sectionMetrics(fixture, fixture.automatic);
    automatic = SweepOps.buildResolved(fixture.automatic);
    axial = SweepOps.buildResolved(fixture.axial);
    legacyBoundaryError = boundaryError(fixture, automatic.solids[0].getShape());
    expect(Number.isFinite(legacyMetrics.maxVertexError)).toBe(true);
    expect(Number.isFinite(legacyMetrics.maxRollDegrees)).toBe(true);
    expect(Number.isFinite(legacyBoundaryError)).toBe(true);
  });
  afterAll(() => {
    if (automatic) disposeSweep(automatic);
    if (axial) disposeSweep(axial);
    fixture?.dispose();
  });

  it("confirms both policies can return closed, positive-volume, valid cutters", () => {
    for (const result of [automatic, axial]) {
      expect(result.solids).toHaveLength(1);
      const validation = ShapeValidator.validate(result.solids[0].getShape());
      expect(validation.findings).toEqual([]);
      expect(validation.solids).toBe(1);
      expect(Number.isFinite(validation.solidVolumes[0])).toBe(true);
    }
  });

  it.fails("automatic transport preserves the authored section under screw motion", () => {
    expect(legacyMetrics.maxVertexError).toBeLessThanOrEqual(SECTION_TOLERANCE);
  });

  it.fails("automatic transport stays within 0.01 degrees of screw motion at every station", () => {
    expect(legacyMetrics.maxRollDegrees).toBeLessThanOrEqual(ROLL_TOLERANCE_DEG);
  });

  it.fails("the automatically built cutter boundary follows the analytic screw surface", () => {
    expect(legacyBoundaryError).toBeLessThanOrEqual(SECTION_TOLERANCE);
  });

  it("qualifies explicit axial transport with the drawn profile at the start vertex", () => {
    const metrics = sectionMetrics(fixture, fixture.axial);
    expect(metrics.maxVertexError).toBeLessThanOrEqual(SECTION_TOLERANCE);
    expect(metrics.maxRollDegrees).toBeLessThanOrEqual(ROLL_TOLERANCE_DEG);
    expect(boundaryError(fixture, axial.solids[0].getShape())).toBeLessThanOrEqual(SECTION_TOLERANCE);
  });

  it("qualifies true Frenet as an independent cylindrical comparator", () => {
    const spec = { ...fixture.axial, transport: { kind: "frenet" as const } };
    const metrics = sectionMetrics(fixture, spec);
    expect(metrics.maxVertexError).toBeLessThanOrEqual(SECTION_TOLERANCE);
    expect(metrics.maxRollDegrees).toBeLessThanOrEqual(ROLL_TOLERANCE_DEG);
  });

  it("uses the same resolved automatic geometry for the remove ghost", () => {
    const ghost = buildSweepGhostSolids({
      getPlane: () => fixture.plane,
      getGeometries: () => fixture.profile.getEdges(),
    }, {
      op: "remove", thin: null, path: fixture.wire,
      faces: [...fixture.automatic.profileFaces],
    });
    try {
      expect(ghost.solids).toHaveLength(1);
      expect(ShapeValidator.signedVolume(ghost.solids[0].getShape())).toBeCloseTo(
        ShapeValidator.signedVolume(automatic.solids[0].getShape()), 5,
      );
      expect(boundaryError(fixture, ghost.solids[0].getShape())).toBeCloseTo(legacyBoundaryError, 6);
    } finally {
      [...ghost.solids, ...ghost.scratch].forEach(shape => shape.dispose());
    }
  });

  it("cuts the independently integrated groove volume with explicit axial transport", () => {
    const oc = getOC();
    const cylinder = new oc.BRepPrimAPI_MakeCylinder(25, 120);
    const stock = cylinder.Shape();
    const args = new oc.TopTools_ListOfShape();
    const tools = new oc.TopTools_ListOfShape();
    const cut = new oc.BRepAlgoAPI_Cut();
    const progress = new oc.Message_ProgressRange();
    try {
      args.Append(stock);
      tools.Append(axial.solids[0].getShape());
      cut.SetArguments(args);
      cut.SetTools(tools);
      cut.SetNonDestructive(true);
      cut.SetRunParallel(true);
      cut.SetFuzzyValue(1e-4);
      cut.Build(progress);
      expect(cut.IsDone()).toBe(true);
      expect(cut.HasErrors()).toBe(false);
      const result = cut.Shape();
      try {
        const validation = ShapeValidator.validate(result);
        expect(validation.findings).toEqual([]);
        expect(validation.solids).toBe(1);
        const removed = Math.PI * 25 ** 2 * 120 - validation.solidVolumes[0];
        const expected = analyticRemovedVolume();
        expect(Math.abs(expected - analyticRemovedVolume(40000))).toBeLessThan(0.001);
        expect(Math.abs(removed - expected)).toBeLessThan(0.05);
      } finally {
        result.delete();
      }
    } finally {
      progress.delete(); cut.delete(); tools.delete(); args.delete(); stock.delete(); cylinder.delete();
    }
  });
});

describe("explicit axial section qualification", () => {
  it.each([
    [10, 5, false], [26, 5, false], [27, 5, false], [28, 5, false], [40, 5, false],
    [10, 32, false], [10, 64, false], [28, 1.25, true], [28, 5, true],
  ] as const)("pitch %s, turns %s, ccw %s", (pitch, turns, ccw) => {
    const fixture = orientationFixture(pitch, turns, ccw);
    try {
      const metrics = sectionMetrics(fixture, fixture.axial);
      expect(metrics.maxVertexError).toBeLessThanOrEqual(SECTION_TOLERANCE);
      expect(metrics.maxRollDegrees).toBeLessThanOrEqual(ROLL_TOLERANCE_DEG);
    } finally {
      fixture.dispose();
    }
  });

  it("preserves offsets about a translated, oblique axis", () => {
    const axis = new Vector3d(1, 2, -3).normalize();
    const frame = new CoordinateSystem(new Point(40, -17, 8), axis, Vector3d.unitX().cross(axis).normalize());
    const fixture = orientationFixture(28, 1.25, true, frame);
    try {
      const metrics = sectionMetrics(fixture, fixture.axial);
      expect(metrics.maxVertexError).toBeLessThanOrEqual(SECTION_TOLERANCE);
      expect(metrics.maxRollDegrees).toBeLessThanOrEqual(ROLL_TOLERANCE_DEG);
    } finally {
      fixture.dispose();
    }
  });
});

describe("fully constrained open-model integration fixture", () => {
  let retainedVolume: number;
  beforeAll(() => {
    getSceneManager().startScene();
    const stockProfile = sketch("xy", () => {
      const c = circle([0, 0], 50);
      fix(c.center(), [0, 0]);
      diameter(c, 50);
    }) as Sketch;
    const stock = extrude(120);
    const path = helix(stock.sideFaces()).turns(5).startOffset(-10).endOffset(10);
    const profile = sketch(plane(path, 0), () => {
      const edges = TRAPEZOID.map((p, i) => line(p, TRAPEZOID[(i + 1) % 4]));
      // One fixed start per edge + one connection per end is a full-rank
      // constraint set. All sixteen endpoint coordinates are determined.
      edges.forEach((edge, i) => {
        fix(edge.start(), TRAPEZOID[i]);
        coincident(edge.end(), edges[(i + 1) % 4].start());
      });
    }) as Sketch;
    const feature = sweep(path, profile).remove() as Sweep;
    render();
    expect(stockProfile.getError()).toBeNull();
    expect(profile.getError()).toBeNull();
    for (const p of [stockProfile, profile]) {
      const solved = p.solver()!.ensureSolved().snapshot;
      expect(solved.outcome).toBe("solved");
      expect(solved.dof).toBe(0);
      expect(solved.conflicting).toEqual([]);
    }
    expect(feature.getError()).toBeNull();
    expect(feature.getShapes()).toHaveLength(1);
    const validation = ShapeValidator.validate(feature.getShapes()[0].getShape());
    expect(validation.findings).toEqual([]);
    expect(validation.solids).toBe(1);
    retainedVolume = validation.solidVolumes[0];
  });

  it("reproduces the research model without sketch or topology failures", () => {
    expect(Number.isFinite(retainedVolume)).toBe(true);
    expect(retainedVolume).toBeGreaterThan(0);
  });

  it.fails("retains the stock outside the intended one-millimetre groove", () => {
    const expected = Math.PI * 25 ** 2 * 120 - analyticRemovedVolume();
    expect(Math.abs(retainedVolume - expected)).toBeLessThan(0.05);
  });
});
