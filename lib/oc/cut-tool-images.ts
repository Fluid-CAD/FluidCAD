import type { TopAbs_ShapeEnum, TopoDS_Shape, TopTools_MapOfShape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { OrientedFaces } from "./oriented-faces.js";
import { ShapeOps, type CleanShapeLineage } from "./shape-ops.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";

/**
 * Where a cut put faces and edges of its tools — the members a removing
 * feature named (a pocket's floor, its walls) — so each names what the
 * cleaned result carries.
 *
 * Two stages, run where the cut runs them:
 *
 * 1. {@link inCut}, once per stock the cut changed, against the boolean
 *    that ran on it: a member the boolean split or reshaped maps to its
 *    `Modified()` images; one it neither changed nor deleted — a pocket
 *    floor lying wholly inside the material comes through as it was — is
 *    its own image when that stock's result holds it; one it deleted (a
 *    floor below the stock, a wall outside it) has none.
 * 2. {@link settle}, once the results were cleaned: the images follow the
 *    cleanup's lineage — the face merge may fold two floor pieces into one
 *    face, so repeats are dropped — and only what the cleaned result
 *    carries is kept, each face as the result references it. A cut turns
 *    the tool's faces inside out (the pocket floor faces up, out of the
 *    material, where the tool's faced down), and the kernel's image lists
 *    carry no in-result orientation, so a face is canonicalized to the
 *    solid's own instance ({@link OrientedFaces}), as the cut's internal
 *    faces are.
 *
 * Images run in stock order. Nothing here changes the cut, its history or
 * its classification: it only reads the builders the cut already ran.
 */
export class CutToolImages {

  /**
   * Each member's images in one stock's cut — `maker` the boolean that ran
   * against it, `result` its shape — parallel to `members`.
   */
  static inCut(maker: any, result: TopoDS_Shape, members: readonly Shape[]): Shape[][] {
    if (members.length === 0) {
      return [];
    }
    const oc = getOC();
    const held = new oc.TopTools_MapOfShape();
    try {
      for (const raw of Explorer.findShapes(result, oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum)) {
        held.Add(raw);
      }
      for (const raw of Explorer.findShapes(result, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum)) {
        held.Add(raw);
      }
      return members.map(member => {
        const raw = member.getShape();
        const type = raw.ShapeType();
        const modified = ShapeOps.shapeListToArray(maker.Modified(raw)).filter(image => image.ShapeType() === type);
        if (modified.length > 0) {
          return modified.map(image => ShapeFactory.fromShape(image));
        }
        if (!maker.IsDeleted(raw) && held.Contains(raw)) {
          return [member];
        }
        return [];
      });
    } finally {
      held.delete();
    }
  }

  /**
   * Each member's images (parallel lists, as {@link inCut} gathered them
   * across the stocks) carried through `cleanups` — whichever cleanup saw an
   * image answers for it, and one no cleanup saw stays as it is — then kept
   * to what `cleaned` carries, faces canonicalized to the result's own
   * instances, repeats dropped.
   */
  static settle(images: Shape[][], cleanups: CleanShapeLineage[], cleaned: Shape[]): Shape[][] {
    if (images.length === 0) {
      return [];
    }
    const oc = getOC();
    const faces = cleaned.map(shape => new OrientedFaces(shape.getShape()));
    const edges = new oc.TopTools_MapOfShape();
    try {
      for (const shape of cleaned) {
        for (const raw of Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum)) {
          edges.Add(raw);
        }
      }
      return images.map(list => {
        const kept: Shape[] = [];
        const seen = new oc.TopTools_MapOfShape();
        try {
          for (const image of list) {
            for (const after of CutToolImages.throughCleanups(image, cleanups)) {
              const settled = CutToolImages.carried(after, faces, edges);
              if (settled && seen.Add(settled.getShape())) {
                kept.push(settled);
              }
            }
          }
        } finally {
          seen.delete();
        }
        return kept;
      });
    } finally {
      faces.forEach(map => map.delete());
      edges.delete();
    }
  }

  /**
   * A member's images by the member: `members` and `images` are parallel.
   * A member is found as the very object tracked, else as the same
   * sub-shape; one that wasn't tracked has none.
   */
  static lookup(members: readonly Shape[], images: Shape[][]): (member: Shape) => Shape[] {
    return (member) => {
      let at = members.indexOf(member);
      if (at < 0) {
        at = members.findIndex(tracked => tracked.getShape().IsSame(member.getShape()));
      }
      return at < 0 ? [] : images[at] ?? [];
    };
  }

  /** What `cleanups` made of a pre-clean image: the first cleanup that saw it answers; none did, it is as it was. */
  private static throughCleanups(image: Shape, cleanups: CleanShapeLineage[]): Shape[] {
    for (const cleanup of cleanups) {
      const after = image.isFace() ? cleanup.remapFace(image as Face) : cleanup.remapEdge(image as Edge);
      if (after !== null) {
        return after;
      }
    }
    return [image];
  }

  /** The cleaned result's instance of `image` — a face as the result references it — or null when the result doesn't carry it. */
  private static carried(image: Shape, faces: OrientedFaces[], edges: TopTools_MapOfShape): Shape | null {
    const raw = image.getShape();
    if (image.isFace()) {
      const holder = faces.find(map => map.has(raw));
      return holder ? Face.fromTopoDSFace(Explorer.toFace(holder.orient(raw))) : null;
    }
    return edges.Contains(raw) ? image : null;
  }
}
