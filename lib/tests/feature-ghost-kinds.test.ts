import { describe, it, expect } from "vitest";
import { setupOC } from "./setup.js";
import { ghostOfCurves, ghostOfSheets, type FeatureGhostResult, type GhostSolid } from "../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Point } from "../math/point.js";
import { TestCurves } from "./helpers/curves.js";
import { TestSheets } from "./helpers/sheets.js";

function solidsOf(result: FeatureGhostResult): GhostSolid[] {
  if ('reason' in result) {
    throw new Error(`the ghost refused: ${result.reason}`);
  }
  return result.solids;
}

describe("the ghost of a curve or a surface tool", () => {
  setupOC();

  it("tags every curve as a wire, a wire and a bare edge alike", () => {
    const wire = TestCurves.threeEdges();
    const edge = EdgeOps.makeLineEdge(new Point(0, 0, 50), new Point(10, 0, 50));

    const solids = solidsOf(ghostOfCurves([wire, edge], DEFAULT_MESH_CONFIG));

    expect(solids.map(solid => solid.kind)).toEqual(["wire", "wire"]);
    // One line mesh per edge of the wire, one for the bare edge.
    expect(solids.map(solid => solid.meshes.length)).toEqual([3, 1]);
    expect(solids.every(solid => solid.meshes.every(mesh => mesh.vertices.length > 0))).toBe(true);
  });

  it("tags every surface as a surface, with its faces meshed", () => {
    const plate = TestSheets.plate(10, 5);
    const strip = TestSheets.strip([[0, 0], [10, 0], [10, 10]], 5);

    const solids = solidsOf(ghostOfSheets([plate, strip], DEFAULT_MESH_CONFIG));

    expect(solids.map(solid => solid.kind)).toEqual(["surface", "surface"]);
    for (const solid of solids) {
      expect(solid.meshes.length).toBeGreaterThan(0);
      expect(solid.meshes.some(mesh => mesh.indices.length > 0)).toBe(true);
    }
  });

  it("frees the shapes it meshed and the scratch built on the way", () => {
    const wire = TestCurves.threeEdges();
    const sheet = TestSheets.plate(10, 5);
    const curveScratch = EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(1, 0, 0));
    const sheetScratch = TestCurves.lineIntoArc();

    ghostOfCurves([wire], DEFAULT_MESH_CONFIG, [curveScratch]);
    ghostOfSheets([sheet], DEFAULT_MESH_CONFIG, [sheetScratch]);

    expect([wire, curveScratch, sheet, sheetScratch].map(shape => shape.isReleased())).toEqual([true, true, true, true]);
  });

  it("answers no body for nothing to draw", () => {
    expect(solidsOf(ghostOfCurves([], DEFAULT_MESH_CONFIG))).toEqual([]);
    expect(solidsOf(ghostOfSheets([], DEFAULT_MESH_CONFIG))).toEqual([]);
  });
});
