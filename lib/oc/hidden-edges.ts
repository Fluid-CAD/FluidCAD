import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopTools_MapOfShape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";

/**
 * Which edges of a B-rep are MODEL edges — creases a user can see, pick and
 * name in a filter — and which are hidden bookkeeping the kernel needs but
 * nobody should ever meet:
 *
 * - a **seam**: the same face lies on both sides, so the face's wires
 *   traverse the edge twice (a cylinder's or sphere's parametric seam, and
 *   the partial seam + period-shifted duplicate arc UnifySameDomain leaves
 *   behind when it merges a band of a periodic face across the seam — see
 *   the boss-on-web case: where that seam sits depends on the sketch plane's
 *   X axis, so any line drawn for it moves with the seam and reads as a
 *   defect);
 * - a **degenerated** edge (a sphere pole, a cone apex): zero length.
 *
 * One rule for every consumer: `Face.getEdges` / `Solid.getEdges` drop them,
 * so `select(edge())`, the feature accessors (`sideEdges()` …) and
 * `edgeCount()` never see them, and the solid-edge renderer skips them while
 * keeping the raw explorer numbering every index-based lookup uses.
 */
export class HiddenEdges {
  /** The raw hidden edges of one face — each once, in explorer order. */
  static ofFace(face: TopoDS_Face): TopoDS_Edge[] {
    const oc = getOC();
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const explorer = new oc.TopExp_Explorer(face, EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum);
    const seen = new oc.TopTools_MapOfShape();
    const hidden = new oc.TopTools_MapOfShape();
    const result: TopoDS_Edge[] = [];
    try {
      while (explorer.More()) {
        const current = explorer.Current();
        const edge = Explorer.toEdge(current);
        // Add() answers false for an edge the face already listed: the seam.
        const firstVisit = seen.Add(current);
        if ((!firstVisit || oc.BRep_Tool.Degenerated(edge)) && hidden.Add(current)) {
          result.push(edge);
        }
        explorer.Next();
      }
      return result;
    } finally {
      explorer.delete();
      seen.delete();
      hidden.delete();
    }
  }

  /**
   * The hidden edges of every face of `shape`, as a set the caller owns
   * (delete it when done).
   */
  static collect(shape: TopoDS_Shape): TopTools_MapOfShape {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const set = new oc.TopTools_MapOfShape();
    for (const raw of Explorer.findShapes(shape, FACE)) {
      for (const edge of HiddenEdges.ofFace(Explorer.toFace(raw))) {
        set.Add(edge);
      }
    }
    return set;
  }
}
