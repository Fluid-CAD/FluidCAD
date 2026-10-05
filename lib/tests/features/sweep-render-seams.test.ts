import { describe, expect, it } from "vitest";
import { setupOC, render } from "../setup.js";
import { coneSweepModel, coneStockVolume } from "../helpers/cone-sweep.js";
import { Solid } from "../../common/solid.js";
import { renderSolid } from "../../rendering/render-solid.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { EdgeConvexityOps } from "../../oc/edge-convexity.js";
import { getOC } from "../../oc/init.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Vector3d } from "../../math/vector3d.js";

function cone(operation: "remove" | "new" | "add"): Solid {
  coneSweepModel(5, 8, true, operation);
  const scene = render();
  expect(scene.getAllSceneObjects().filter(o => o.getError()).map(o => o.getError())).toEqual([]);
  const feature = scene.getAllSceneObjects().find(o => o.getType() === "sweep")!;
  const solids = feature.getShapes();
  expect(solids).toHaveLength(1);
  return solids[0] as Solid;
}

function assertLinework(solid: Solid) {
  const volume = ShapeValidator.signedVolume(solid.getShape());
  const raw = solid.getIndexedShapes("edge");
  const seams = solid.getRenderSeams();
  const drawn = renderSolid(solid).filter(mesh => mesh.label === "solid-edges");
  expect(seams.length).toBeGreaterThan(0);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.filter(mesh => mesh.smooth)).toEqual([]);
  for (const mesh of drawn) {
    expect(mesh.edgeIndex).toBeDefined();
    expect(seams.some(edge => edge.IsSame(raw[mesh.edgeIndex!].getShape()))).toBe(false);
  }
  // Every real crease in the user's solid remains drawn. This uses the
  // existing model rather than constructing an unrelated kernel primitive.
  const oc = getOC();
  raw.forEach((edge, index) => {
    if (solid.isHiddenEdge(edge.getShape())) return;
    const parents = solid.getEdgeToFacesIndex().Seek(edge.getShape());
    if (!parents || parents.Size() !== 2) return;
    const nativeEdge = oc.TopoDS.Edge(edge.getShape());
    const a = parents.First(), b = parents.Last();
    try {
      if (!a.IsSame(b) && !EdgeConvexityOps.isSmoothRaw(nativeEdge, a, b)) {
        expect(drawn.some(mesh => mesh.edgeIndex === index)).toBe(true);
      }
    } finally { nativeEdge.delete(); a.delete(); b.delete(); }
  });
  // Display suppression does not remove B-rep edges or change raw indexing.
  expect(seams.every(edge => raw.some(candidate => candidate.getShape().IsSame(edge)))).toBe(true);
  expect(ShapeValidator.signedVolume(solid.getShape())).toBe(volume);
}

describe("sweep construction seams", () => {
  setupOC();

  it.each(["new", "add", "remove"] as const)("draws only the actual boundaries of a cone sweep in %s mode", operation => {
    const solid = cone(operation);
    assertLinework(solid);
    const volume = ShapeValidator.signedVolume(solid.getShape());
    if (operation === "remove") expect(Math.abs(coneStockVolume() - volume - 3555.378249)).toBeLessThan(0.05);
    if (operation === "add") expect(volume).toBeGreaterThan(coneStockVolume());
  });

  it("retains display provenance through copies and transforms without depending on source metadata handles", () => {
    const source = cone("new");
    const copied = source.copy() as Solid;
    const translated = ShapeOps.transform(source, Matrix4.fromTranslationVector(new Vector3d(40, -20, 7))) as Solid;
    const retained = new Set<object>();
    copied.collectRawHandles(retained);
    source.release(retained, new Set());
    try {
      expect(source.isReleased()).toBe(true);
      assertLinework(copied);
      assertLinework(translated);
    } finally {
      copied.dispose(); translated.dispose();
    }
  });
});
