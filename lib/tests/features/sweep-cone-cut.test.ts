import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getSceneManager } from "../../scene-manager.js";
import type { Sketch } from "../../features/2d/sketch.js";
import type { ResolvedHelixGeometry } from "../../math/helix-geometry.js";
import { Point } from "../../math/point.js";
import { Explorer } from "../../oc/explorer.js";
import { getOC } from "../../oc/init.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { SweepOps, type SweepResult } from "../../oc/sweep-ops.js";
import { render, setupOC } from "../setup.js";
import { coneStockVolume, coneSweepModel } from "../helpers/cone-sweep.js";
import { coneSectionPoint, coneSweepVolume } from "../helpers/cone-sweep-oracle.js";
import helix from "../../core/helix.js";
import plane from "../../core/plane.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import { circle } from "../../core/2d/index.js";
import { coincident, diameter } from "../../core/constraints/index.js";
import { origin } from "../../core/index.js";
import type { Sweep } from "../../features/sweep.js";
import type { Face } from "../../common/face.js";

describe("subtractive cone helix regression", () => {
  let geometry: ResolvedHelixGeometry;
  let profile: Sketch;
  let stock: TopoDS_Shape;
  let result: TopoDS_Shape;
  let cutter: TopoDS_Shape;
  let roles: SweepResult["faceRoles"];

  beforeAll(() => {
    const expensive = vi.spyOn(getOC().BRepAlgoAPI_Check.prototype, "Perform").mockImplementation(() => {
      throw new Error("Native self-interference must not run during rendering");
    });
    const build = SweepOps.buildResolved;
    const capture = vi.spyOn(SweepOps, "buildResolved").mockImplementation(spec => {
      expect(spec.transport.kind).toBe("binormal");
      expect(spec.placement.kind).toBe("legacyAutomatic");
      expect(spec.helixGeometry).toBeDefined();
      geometry = spec.helixGeometry!;
      const swept = build(spec);
      cutter = swept.solids[0].getShape().Oriented(swept.solids[0].getShape().Orientation());
      roles = swept.faceRoles;
      return swept;
    });
    try {
      getSceneManager().startScene();
      coneSweepModel();
      const scene = render();
      const objects = scene.getAllSceneObjects();
      expect(objects.filter(o => o.getError()).map(o => o.getError())).toEqual([]);
      const sketches = objects.filter(o => o.getType() === "sketch") as Sketch[];
      sketches.forEach(sketch => expect(sketch.solver()!.ensureSolved().snapshot.dof).toBe(0));
      profile = sketches.at(-1)!;
      const original = objects.find(o => o.getType() === "extrude")!.getAddedShapes()[0].getShape();
      const cut = objects.find(o => o.getType() === "sweep")!.getShapes();
      expect(cut).toHaveLength(1);
      stock = original.Oriented(original.Orientation());
      result = cut[0].getShape().Oriented(cut[0].getShape().Orientation());
      expect(expensive).not.toHaveBeenCalled();
    } finally { capture.mockRestore(); expensive.mockRestore(); }
  });

  afterAll(() => { stock?.delete(); result?.delete(); cutter?.delete(); });

  it("removes the independently integrated groove and preserves the original stock", () => {
    expect(Math.abs(ShapeValidator.signedVolume(stock) - coneStockVolume())).toBeLessThan(1e-5);
    const coarse = coneSweepVolume(geometry, profile.getPlane(), 8, 400);
    const expected = coneSweepVolume(geometry, profile.getPlane(), 8, 800);
    expect(Math.abs(coarse - expected)).toBeLessThan(0.005);
    const validation = ShapeValidator.validate(result);
    expect(validation.findings).toEqual([]);
    expect(validation.solids).toBe(1);
    const removed = coneStockVolume() - validation.solidVolumes[0];
    expect(expected).toBeGreaterThan(3500);
    expect(Math.abs(removed - expected)).toBeLessThan(0.05);
  });

  it("removes material at several groove stations while keeping the deeper core", () => {
    const oc = getOC();
    const stockClassifier = new oc.BRepClass3d_SolidClassifier(stock);
    const resultClassifier = new oc.BRepClass3d_SolidClassifier(result);
    try {
      for (const station of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        for (const depth of [1, 5]) {
          const p = coneSectionPoint(geometry, profile.getPlane(), station, 0, depth);
          const point = new oc.gp_Pnt(p.x, p.y, p.z);
          try {
            stockClassifier.Perform(point, 1e-6);
            resultClassifier.Perform(point, 1e-6);
            expect(stockClassifier.State()).toBe(oc.TopAbs_State.TopAbs_IN);
            expect(resultClassifier.State()).toBe(depth === 1 ? oc.TopAbs_State.TopAbs_OUT : oc.TopAbs_State.TopAbs_IN);
          } finally { point.delete(); }
        }
      }
    } finally { stockClassifier.delete(); resultClassifier.delete(); }
  });

  it("keeps the actual cutter boundary on the same analytic binormal transport", () => {
    const oc = getOC();
    const shells = Explorer.findShapes(cutter, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    expect(shells).toHaveLength(1);
    const polygon = [[2.5, -3], [-2.5, -3], [-1.1602540378443864, 2], [1.1602540378443864, 2]];
    const samples = polygon.flatMap((p, i) => {
      const q = polygon[(i + 1) % 4];
      return [p, [p[0] + 0.37 * (q[0] - p[0]), p[1] + 0.37 * (q[1] - p[1])]];
    });
    try {
      for (const fraction of [0.07, 0.23, 0.47, 0.71, 0.93]) {
        for (const [u, v] of samples) {
          const expected: Point = coneSectionPoint(geometry, profile.getPlane(), fraction, u, v);
          const point = new oc.gp_Pnt(expected.x, expected.y, expected.z);
          const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(point);
          const vertex = vertexMaker.Vertex();
          const progress = new oc.Message_ProgressRange();
          const distance = new oc.BRepExtrema_DistShapeShape(vertex, shells[0],
            oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress);
          try {
            expect(distance.IsDone()).toBe(true);
            expect(distance.Value()).toBeLessThan(1e-3);
          } finally { distance.delete(); progress.delete(); vertex.delete(); vertexMaker.delete(); point.delete(); }
        }
      }
    } finally { shells.forEach(shell => shell.delete()); }
    const sideRoles = roles.filter(r => r.kind === "side");
    expect(sideRoles.length).toBeGreaterThan(0);
    expect(sideRoles.every(r => r.profileMidpoint !== undefined)).toBe(true);
    expect(roles.filter(r => r.kind === "start")).toHaveLength(1);
    expect(roles.filter(r => r.kind === "end")).toHaveLength(1);
  });
});

describe("bounded tapered sweep wall history", () => {
  setupOC();

  it.each([18, 12])("keeps inner walls across every span when end radius is %s", endRadius => {
    const path = helix("z").radius(15).endRadius(endRadius).height(20).turns(1);
    const profile = sketch(plane(path, 0), () => {
      const c = circle([0, 0], 4);
      coincident(c.center(), origin()); diameter(c, 4);
    });
    const feature = sweep(path, profile).thin(0.5).new() as Sweep;
    render();
    expect(feature.getError()).toBeNull();
    expect(feature.getShapes()).toHaveLength(1);
    const inner = feature.getState("internal-faces") as Face[];
    const outer = feature.getState("side-faces") as Face[];
    // A 45-degree budget plus one extra span avoids periodic-meridian seams.
    expect(inner).toHaveLength(9);
    expect(outer).toHaveLength(9);
    expect(ShapeValidator.validate(feature.getShapes()[0].getShape()).findings).toEqual([]);
  });
});
