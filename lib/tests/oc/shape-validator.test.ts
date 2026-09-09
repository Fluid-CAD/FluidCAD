import { describe, it, expect } from "vitest";
import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
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

/**
 * A solid whose only shell carries `faceCount` of the box's six faces —
 * built at the kernel level because the DSL cannot produce an open body.
 * Every handle the builder hands out stays owned by the returned solid.
 */
function makeOpenBox(faceCount: number): TopoDS_Shape {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const faces = Explorer.findShapes(makeBox(), FACE).slice(0, faceCount);
  const builder = new oc.BRep_Builder();
  const shell = new oc.TopoDS_Shell();
  builder.MakeShell(shell);
  for (const face of faces) {
    builder.Add(shell, face);
  }
  const solid = new oc.TopoDS_Solid();
  builder.MakeSolid(solid);
  builder.Add(solid, shell);
  builder.delete();
  return solid;
}

describe("ShapeValidator", () => {
  setupOC();

  it("a sound box has no findings and a positive volume", () => {
    const report = ShapeValidator.validate(makeBox());
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ faces: 6, edges: 12, shells: 1, solids: 1, validTopology: true, closed: true });
    expect(report.solidVolumes).toHaveLength(1);
    expect(report.solidVolumes[0]).toBeCloseTo(4000, 3);
  });

  it("a reversed solid passes BRepCheck_Analyzer and is caught by the volume sign only", () => {
    const reversed = makeBox().Reversed();
    const report = ShapeValidator.validate(reversed);
    // The documented OCCT subtlety: the analyzer is orientation-blind.
    expect(report.validTopology).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.solidVolumes[0]).toBeCloseTo(-4000, 3);
    expect(report.findings.map(f => f.kind)).toEqual(['nonPositiveVolume']);
    expect(report.findings[0].message).toContain('reversed');
  });

  it("a five-face box is an open shell", () => {
    const report = ShapeValidator.validate(makeOpenBox(5));
    expect(report.closed).toBe(false);
    expect(report.faces).toBe(5);
    const kinds = report.findings.map(f => f.kind);
    expect(kinds).toContain('openShell');
    // The open box is still "a solid" to the explorer, so noSolid must not fire.
    expect(kinds).not.toContain('noSolid');
    expect(report.solids).toBe(1);
  });

  it("a bare face is noSolid, and only that", () => {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const face = Explorer.findShapes(makeBox(), FACE)[0];
    const report = ShapeValidator.validate(face);
    expect(report.solids).toBe(0);
    expect(report.solidVolumes).toEqual([]);
    expect(report.findings.map(f => f.kind)).toEqual(['noSolid']);
    expect(report.findings[0].message).toContain('1 face');
  });

  it("volumes are per solid, never summed: a compound of a box and its inverse still reports the inversion", () => {
    const box = makeBox();
    const oc = getOC();
    const builder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    builder.MakeCompound(compound);
    builder.Add(compound, box);
    builder.Add(compound, box.Reversed());
    builder.delete();

    const report = ShapeValidator.validate(compound);
    expect(report.solids).toBe(2);
    expect(report.solidVolumes.map(v => Math.round(v))).toEqual([4000, -4000]);
    expect(report.findings.map(f => f.kind)).toEqual(['nonPositiveVolume']);
    expect(report.findings[0].message).toContain('solid 2 of 2');
  });

  it("names the checks it runs and the one this kernel build cannot", () => {
    expect(ShapeValidator.CHECKS).toEqual(['invalidTopology', 'openShell', 'nonPositiveVolume', 'noSolid']);
    expect(Object.keys(ShapeValidator.UNAVAILABLE)).toEqual(['selfIntersecting']);
    expect(ShapeValidator.UNAVAILABLE.selfIntersecting).toContain('BRepAlgoAPI_Check');
  });
});
