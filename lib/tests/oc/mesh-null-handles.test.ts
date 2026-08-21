import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { Mesh } from "../../oc/mesh.js";
import type { TopoDS_Edge, TopoDS_Face } from "ocjs-fluidcad";

/** A freshly built shape carries no triangulation until something meshes it. */
function unmeshedCylinder() {
  const oc = getOC();
  const shape = new oc.BRepPrimAPI_MakeCylinder(10, 20).Shape();
  return {
    face: oc.TopoDS.Face(Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE)[0]) as TopoDS_Face,
    edge: oc.TopoDS.Edge(Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE)[0]) as TopoDS_Edge,
  };
}

/**
 * Embind maps a null OCCT `Handle` to JS `null`, not to a wrapper — so the
 * `handle.IsNull()` idiom cannot work here, and a guard written that way
 * throws instead of guarding. The mesh readers must test the value itself.
 *
 * This mattered: a face the kernel could not mesh used to surface as
 * "Cannot read properties of null (reading 'isNull')" rather than as a
 * skipped face.
 */
describe("mesh readers on shapes with no triangulation", () => {
  setupOC();

  it("returns a null handle as JS null", () => {
    const oc = getOC();
    const { face, edge } = unmeshedCylinder();
    const loc = new oc.TopLoc_Location();

    expect(oc.BRep_Tool.Triangulation(face, loc, 0)).toBeNull();
    expect(oc.BRep_Tool.Polygon3D(edge, loc)).toBeNull();

    loc.delete();
  });

  it("skips an unmeshed face instead of throwing", () => {
    const { face } = unmeshedCylinder();
    expect(Mesh.extractFaceTriangulationRaw(face)).toBeNull();
  });

  it("skips an edge whose parent face is unmeshed instead of throwing", () => {
    const { face, edge } = unmeshedCylinder();
    expect(Mesh.discretizeEdgeOnFace(edge, face)).toBeNull();
  });
});
