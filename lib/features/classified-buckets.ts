import type { TopAbs_ShapeEnum, TopTools_MapOfShape } from "ocjs-fluidcad";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { Explorer } from "../oc/explorer.js";
import { FaceQuery } from "../oc/face-query.js";
import { getOC } from "../oc/init.js";

/** A face bucket carried across a fusion; see {@link ClassifiedBucketRemapper.remapFaces}. */
export type RemappedFaces = {
  /**
   * The bucket as it stands in the final solid, in as-built order: each
   * as-built face contributes its post-fusion images, or the stock face it
   * merged into. Positional, so index picks (`e.sideFaces(4)`) keep meaning.
   */
  faces: Face[];
  /** The entries that are the feature's own geometry — images of its as-built faces, not adopted stock faces. */
  own: Face[];
};

/**
 * Carries a 3D op's start and end buckets (faces, and the edges derived from
 * them) across the fusion that merged the op's body into the scene, so every
 * member names a sub-shape of the final solid.
 *
 * The tool-side history answers most of it: a face or edge the boolean split
 * or reshaped maps to its `Modified` images, an untouched one keeps its
 * identity. The case the history cannot answer is a face the fusion
 * *removed* — a boss's start disc that lies on the plate it was built on is
 * merged into the plate and has no image at all. Its boundary edges survive
 * (as the junction between the boss walls and the plate), so the bucket's
 * edges are remapped on their own through the edge history rather than
 * re-derived from the face, and the face itself is re-homed onto the face of
 * the final solid that shares its surface and carries those edges — the face
 * the feature grew from. Anything still absent from the final solid after
 * that is dropped: a stale member only ever fails downstream ("matched no
 * solid").
 */
export class ClassifiedBucketRemapper {

  private readonly finalFaces: TopTools_MapOfShape;
  private readonly finalEdges: TopTools_MapOfShape;
  private readonly finalFaceList: Face[];

  constructor(private readonly history: ShapeHistory, finalShapes: Shape[]) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    this.finalFaces = new oc.TopTools_MapOfShape();
    this.finalEdges = new oc.TopTools_MapOfShape();
    this.finalFaceList = [];
    for (const shape of finalShapes) {
      for (const raw of Explorer.findShapes(shape.getShape(), FACE)) {
        if (this.finalFaces.Add(raw)) {
          this.finalFaceList.push(Face.fromTopoDSFace(Explorer.toFace(raw)));
        }
      }
      for (const raw of Explorer.findShapes(shape.getShape(), EDGE)) {
        this.finalEdges.Add(raw);
      }
    }
  }

  dispose() {
    this.finalFaces.delete();
    this.finalEdges.delete();
  }

  /**
   * The bucket's edges as they exist in the final solid: each as-built edge
   * follows its `Modified` images, then anything the solid no longer carries
   * is dropped.
   */
  remapEdges(edges: Edge[]): Edge[] {
    const remapped = ShapeHistoryTracker.remapEdges(edges, this.history);
    return ClassifiedBucketRemapper.distinct(remapped.filter(e => this.finalEdges.Contains(e.getShape())));
  }

  /**
   * The bucket's faces as they exist in the final solid. A face the fusion
   * removed is re-homed onto the final face that shares its surface and
   * carries one of `anchorEdges` (the bucket's already-remapped edges) —
   * several regions that merged into the same stock face all re-home onto
   * it, so the result stays positional and may repeat a face.
   */
  remapFaces(faces: Face[], anchorEdges: Edge[]): RemappedFaces {
    const result: RemappedFaces = { faces: [], own: [] };
    const anchors = this.shapeMap(anchorEdges);
    try {
      for (const face of faces) {
        if (this.wasRemoved(face)) {
          const home = this.findAbsorbingFace(face, anchors);
          if (home) {
            result.faces.push(home);
          }
          continue;
        }
        for (const image of ShapeHistoryTracker.remapFaces([face], this.history)) {
          if (this.finalFaces.Contains(image.getShape())) {
            result.faces.push(image);
            result.own.push(image);
          }
        }
      }
      return result;
    } finally {
      anchors.delete();
    }
  }

  /** The shapes with repeats removed, first occurrence kept. */
  static distinct<T extends Shape>(shapes: T[]): T[] {
    if (shapes.length < 2) {
      return shapes;
    }
    const seen = new (getOC().TopTools_MapOfShape)();
    try {
      return shapes.filter(s => seen.Add(s.getShape()));
    } finally {
      seen.delete();
    }
  }

  private wasRemoved(face: Face): boolean {
    const raw = face.getShape();
    const hasImage = this.history.modifiedFaces.some(m => m.sources.some(s => s.getShape().IsSame(raw)));
    if (hasImage) {
      return false;
    }
    return this.history.removedFaces.some(r => r.getShape().IsSame(raw));
  }

  private findAbsorbingFace(removed: Face, anchors: TopTools_MapOfShape): Face | null {
    if (anchors.IsEmpty()) {
      return null;
    }
    for (const candidate of this.finalFaceList) {
      if (!FaceQuery.isSameSurface(removed, candidate)) {
        continue;
      }
      if (candidate.getEdges().some(e => anchors.Contains(e.getShape()))) {
        return candidate;
      }
    }
    return null;
  }

  private shapeMap(shapes: Shape[]): TopTools_MapOfShape {
    const map = new (getOC().TopTools_MapOfShape)();
    for (const shape of shapes) {
      map.Add(shape.getShape());
    }
    return map;
  }
}
