import type { TopoDS_Shape, TopTools_IndexedMapOfShape } from "ocjs-fluidcad";
import { getOC } from "./init.js";

/**
 * The faces of a result shape, each carrying the orientation it has INSIDE
 * that shape.
 *
 * OCCT history lists — `BRepBuilderAPI_MakeShape::Modified/Generated`,
 * `BRepTools_History::Modified` — hand back images as the algorithm stored
 * them (a face typically FORWARD), not as the result's shell references
 * them. A face wrapped straight off such a list can therefore report an
 * inward normal: `Face.calculateNormal` honours the orientation flag, and so
 * do the sketch plane on a face and every normal-based filter. Every place
 * that stores a history-returned face as classification (start/end/side
 * buckets, modification lineage) must first canonicalize it through
 * {@link orient} so the stored face is the one the solid actually contains.
 *
 * Edges are deliberately not covered: an edge's orientation inside a shell
 * is per adjacent face, so there is no single "in-result" orientation to
 * restore, and nothing reads an edge's orientation as a direction.
 *
 * Wraps an OCCT indexed map, so it owns native memory — `delete()` when done.
 */
export class OrientedFaces {
  private readonly map: TopTools_IndexedMapOfShape;

  constructor(result: TopoDS_Shape) {
    const oc = getOC();
    this.map = new oc.TopTools_IndexedMapOfShape();
    // TopExp::MapShapes explores with composed orientation, so each stored
    // face is oriented exactly as the result references it.
    oc.TopExp.MapShapes(result, oc.TopAbs_ShapeEnum.TopAbs_FACE, this.map);
  }

  /**
   * The instance of `face` inside the result (same TShape and location, the
   * result's orientation). A face the result does not contain is returned
   * unchanged — a caller may legitimately hold faces that a later cleanup
   * removed, and those keep whatever orientation they had.
   */
  orient(face: TopoDS_Shape): TopoDS_Shape {
    const index = this.map.FindIndex(face);
    return index === 0 ? face : this.map.FindKey(index);
  }

  delete(): void {
    this.map.delete();
  }
}
