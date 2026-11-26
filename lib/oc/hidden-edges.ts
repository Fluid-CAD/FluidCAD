import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopTools_MapOfShape } from "ocjs-fluidcad";
import { getOC } from "./init.js";

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
 *
 * This module does not import `Explorer`: `BodyShape` reads its hidden edges
 * here, and the explorer imports the body classes, so that import would
 * close a cycle that runs `class Solid extends BodyShape` before `BodyShape`
 * exists whenever a body module is the first to load.
 */
export class HiddenEdges {
  /**
   * The raw hidden edges of one face — each once, in explorer order. The
   * caller owns the returned copies (delete them when done).
   */
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
        const edge = oc.TopoDS.Edge(current);
        // Add() answers false for an edge the face already listed: the seam.
        const firstVisit = seen.Add(current);
        if ((!firstVisit || oc.BRep_Tool.Degenerated(edge)) && hidden.Add(current)) {
          result.push(edge);
        } else {
          edge.delete();
        }
        current.delete();
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
    // The map holds its own TShape references; every copy made on the way
    // is freed once it is in. A face the walk meets twice adds nothing new.
    const explorer = new oc.TopExp_Explorer(shape, FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum);
    try {
      while (explorer.More()) {
        const current = explorer.Current();
        const face = oc.TopoDS.Face(current);
        try {
          for (const edge of HiddenEdges.ofFace(face)) {
            set.Add(edge);
            edge.delete();
          }
        } finally {
          face.delete();
          current.delete();
        }
        explorer.Next();
      }
    } finally {
      explorer.delete();
    }
    return set;
  }

  /**
   * The model edges among `edges` — any of `shape`'s edges, typically its
   * whole explorer-order list — with the hidden ones dropped and the rest in
   * their original order. For consumers that walk raw explorer edges (pick
   * indices count seams) but must only ever offer what a user can see.
   */
  static visibleOf<T extends { getShape(): TopoDS_Shape }>(shape: TopoDS_Shape, edges: T[]): T[] {
    const hidden = HiddenEdges.collect(shape);
    try {
      return edges.filter(edge => !hidden.Contains(edge.getShape()));
    } finally {
      hidden.delete();
    }
  }
}
