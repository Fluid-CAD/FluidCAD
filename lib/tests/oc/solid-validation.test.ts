import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { checkNativeShape } from "../../oc/native-shape-check.js";
import { requireValidSolid } from "../../oc/solid-validation.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { SweepOps } from "../../oc/sweep-ops.js";
import { buildSweepGhostSolids } from "../../features/sweep-ghost.js";
import { orientationFixture } from "../helpers/sweep-orientation.js";

const owned: { delete(): void }[] = [];
function keep<T extends { delete(): void }>(item: T): T { owned.push(item); return item; }
afterEach(() => { vi.restoreAllMocks(); owned.reverse().forEach(item => item.delete()); owned.length = 0; });

function cylinder(x = 0): TopoDS_Shape {
  const oc = getOC();
  const point = keep(new oc.gp_Pnt(x, 0, 0));
  const axis = keep(new oc.gp_Ax2(point, keep(new oc.gp_Dir(0, 0, 1))));
  return keep(keep(new oc.BRepPrimAPI_MakeCylinder(axis, 2, 5)).Shape());
}

function compound(shapes: TopoDS_Shape[]) {
  const oc = getOC();
  const result = keep(new oc.TopoDS_Compound());
  const builder = keep(new oc.BRep_Builder());
  builder.MakeCompound(result); shapes.forEach(shape => builder.Add(result, shape));
  return result;
}

describe("runtime solid validation", () => {
  it("accepts a sound solid without mutating it", () => {
    const shape = cylinder();
    const before = ShapeValidator.signedVolume(shape);
    expect(requireValidSolid(shape, "test cutter", 1).findings).toEqual([]);
    expect(ShapeValidator.signedVolume(shape)).toBe(before);
  });

  it("detects actual self-interference that basic topology and volume checks accept", () => {
    const shape = compound([cylinder(), cylinder(1)]);
    expect(ShapeValidator.validate(shape).findings).toEqual([]);
    const native = checkNativeShape(shape);
    expect(native.valid).toBe(false);
    expect(native.faults.some(f => f.status === getOC().BOPAlgo_CheckStatus.BOPAlgo_SelfIntersect)).toBe(true);
    expect(native.faults.some(f => f.subshapes > 0)).toBe(true);
    expect(() => requireValidSolid(shape, "test cutter", undefined, { selfInterference: true })).toThrow(/test cutter validation failed.*BOPAlgo_SelfIntersect/);
  });

  it("rejects reversed volume before running the native argument check", () => {
    const shape = keep(cylinder().Reversed());
    const perform = vi.spyOn(getOC().BRepAlgoAPI_Check.prototype, "Perform");
    expect(() => requireValidSolid(shape, "test cutter", undefined, { selfInterference: true })).toThrow(/nonPositiveVolume/);
    expect(perform).not.toHaveBeenCalled();
  });

  it("enforces the expected solid count", () => {
    const shape = compound([cylinder(), cylinder(10)]);
    expect(() => requireValidSolid(shape, "test cutter", 1)).toThrow(/expected 1 solid\(s\), received 2/);
    expect(requireValidSolid(shape, "test result").solids).toBe(2);
  });

  it.each([NaN, Infinity])("rejects non-finite volume %s", volume => {
    vi.spyOn(ShapeValidator, "signedVolume").mockReturnValue(volume);
    expect(() => requireValidSolid(cylinder(), "test cutter")).toThrow(/nonFiniteGeometry/);
  });

  it("rejects a non-finite bound even when volume is positive", () => {
    vi.spyOn(getOC().Bnd_Box.prototype, "GetXMin").mockReturnValue(Infinity);
    expect(() => requireValidSolid(cylinder(), "test cutter")).toThrow(/nonFiniteGeometry/);
  });

  it("reports native checker failure as failure to validate and releases the checker", () => {
    const oc = getOC();
    vi.spyOn(oc.BRepAlgoAPI_Check.prototype, "HasErrors").mockReturnValue(true);
    const release = vi.spyOn(oc.BRepAlgoAPI_Check.prototype, "delete");
    expect(() => requireValidSolid(cylinder(), "test cut result", undefined, { selfInterference: true })).toThrow(/test cut result validation failed.*failed to complete/);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("distinguishes native execution failures reported as fault statuses", () => {
    const oc = getOC();
    const shape = compound([cylinder(), cylinder(1)]);
    vi.spyOn(oc.BOPAlgo_CheckResult.prototype, "GetCheckStatus")
      .mockReturnValue(oc.BOPAlgo_CheckStatus.BOPAlgo_OperationAborted);
    expect(() => requireValidSolid(shape, "test cutter", undefined, { selfInterference: true }))
      .toThrow(/analysis did not complete: BOPAlgo_OperationAborted/);
  });

  it("reports a missing binding and does not substitute another check", () => {
    const oc = getOC();
    const original = oc.BRepAlgoAPI_Check;
    Object.assign(oc, { BRepAlgoAPI_Check: undefined });
    try { expect(() => requireValidSolid(cylinder(), "test cutter", undefined, { selfInterference: true })).toThrow(/Missing WASM binding: BRepAlgoAPI_Check/); }
    finally { Object.assign(oc, { BRepAlgoAPI_Check: original }); }
  });

  it("refuses a cleanup requiring repair without history", () => {
    const oc = getOC();
    const faces = Explorer.findShapes(cylinder(), oc.TopAbs_ShapeEnum.TopAbs_FACE).map(keep);
    const builder = keep(new oc.BRep_Builder());
    const shell = keep(new oc.TopoDS_Shell());
    const solid = keep(new oc.TopoDS_Solid());
    builder.MakeShell(shell);
    faces.slice(0, 2).forEach(face => builder.Add(shell, face));
    builder.MakeSolid(solid); builder.Add(solid, shell);
    const shape = ShapeFactory.fromShape(solid);
    const repair = vi.spyOn(oc.ShapeFix_Shape.prototype, "Perform");
    try {
      expect(() => ShapeOps.cleanShapeWithLineage(shape, { skipSimplify: true, requireLineage: true }))
        .toThrow(/ShapeFix without trustworthy history/);
      expect(repair).not.toHaveBeenCalled();
    } finally { shape.dispose(); }
  });

  it("never runs native self-interference analysis for automatic sweeps or previews", () => {
    const perform = vi.spyOn(getOC().BRepAlgoAPI_Check.prototype, "Perform").mockImplementation(() => {
      throw new Error("Expensive native diagnostics must not run automatically");
    });
    const fixture = orientationFixture(28, 1);
    try {
      const built = SweepOps.buildResolved(fixture.automatic);
      try { expect(built.solids).toHaveLength(1); }
      finally { built.solids.forEach(s => s.dispose()); built.firstShape.delete(); built.lastShape.delete(); }
      const ghost = buildSweepGhostSolids({ getPlane: () => fixture.plane, getGeometries: () => fixture.profile.getEdges() }, {
        op: "remove", thin: null, path: fixture.wire, faces: [...fixture.automatic.profileFaces],
      });
      try { expect(ghost.solids).toHaveLength(1); }
      finally { [...ghost.solids, ...ghost.scratch].forEach(s => s.dispose()); }
      expect(perform).not.toHaveBeenCalled();
    } finally { fixture.dispose(); }
  });
});
