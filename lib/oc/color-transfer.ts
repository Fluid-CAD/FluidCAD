import type { BRepBuilderAPI_MakeShape, TopAbs_ShapeEnum, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import type { CleanShapeLineage } from "./shape-ops.js";

/**
 * Walk each source shape's `colorMap`, find where each colored face ended up in
 * the result shapes via `maker.Modified()` (falling back to the unchanged face
 * if `!IsDeleted`), and apply the color to whichever result shape now owns it.
 *
 * Works for any `BRepBuilderAPI_MakeShape`-derived maker — fuse, cut, fillet,
 * chamfer, transform, etc.
 */
export class ColorTransfer {
  static applyThroughMaker(
    sources: Shape[],
    results: Shape[],
    maker: BRepBuilderAPI_MakeShape,
  ) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;

    for (const source of sources) {
      if (!source.hasColors()) {
        continue;
      }

      for (const entry of source.colorMap) {
        const modifiedRaws = ShapeOps.shapeListToArray(maker.Modified(entry.shape))
          .filter(s => s.ShapeType() === FACE);

        let targets: TopoDS_Shape[];
        if (modifiedRaws.length > 0) {
          targets = modifiedRaws;
        } else if (!maker.IsDeleted(entry.shape)) {
          targets = [entry.shape];
        } else {
          continue;
        }

        for (const target of targets) {
          for (const result of results) {
            const faces = Explorer.findShapes(result.getShape(), FACE);
            if (faces.some(f => f.IsSame(target))) {
              result.setColor(target, entry.color);
              break;
            }
          }
        }
      }
    }
  }

  /**
   * Color bleed pass: spreads colors to result faces that came from new
   * geometry (tool inputs, generated faces, or just brand-new) by walking
   * face-edge adjacency in each result solid.
   *
   * Faces that came from `sceneSources` (whether modified or unchanged) are
   * NOT bled — those represent existing geometry whose color state the user
   * explicitly chose. Faces NOT from any sceneSource are eligible: this
   * covers tool extrusions, fillet/chamfer-generated surfaces, and cut
   * section faces.
   *
   * Iterates until stable so newly-bled faces can spread color further.
   * Call AFTER `applyThroughMaker` so the colored seeds are in place.
   */
  static applyBleeding(
    sceneSources: Shape[],
    results: Shape[],
    maker: BRepBuilderAPI_MakeShape,
  ) {
    // No colors anywhere on the source side means the bleed loop will iterate
    // every result face only to find nothing to spread. Short-circuit before
    // building maps or running the O(N²·E²) adjacency scan.
    if (!sceneSources.some(s => s.hasColors())) {
      return;
    }

    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    const protectedFaces = new oc.TopTools_MapOfShape();
    for (const scene of sceneSources) {
      for (const inputFace of Explorer.findShapes(scene.getShape(), FACE)) {
        const modified = ShapeOps.shapeListToArray(maker.Modified(inputFace))
          .filter(s => s.ShapeType() === FACE);
        if (modified.length > 0) {
          for (const r of modified) {
            protectedFaces.Add(r);
          }
        } else if (!maker.IsDeleted(inputFace)) {
          protectedFaces.Add(inputFace);
        }
      }
    }

    for (const result of results) {
      const allFaces = Explorer.findShapes(result.getShape(), FACE);
      // Cache edges per face — repeated `findShapes` is expensive.
      const faceEdges = allFaces.map(f => Explorer.findShapes(f, EDGE));

      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < allFaces.length; i++) {
          const face = allFaces[i];
          if (protectedFaces.Contains(face)) {
            continue;
          }
          if (result.getColor(face)) {
            continue;
          }

          const myEdges = faceEdges[i];
          for (let j = 0; j < allFaces.length; j++) {
            if (i === j) {
              continue;
            }
            const otherEdges = faceEdges[j];
            const adjacent = myEdges.some(me => otherEdges.some(oe => me.IsSame(oe)));
            if (!adjacent) {
              continue;
            }
            const otherColor = result.getColor(allFaces[j]);
            if (otherColor) {
              result.setColor(face, otherColor);
              changed = true;
              break;
            }
          }
        }
      }
    }

    protectedFaces.delete();
  }

  /**
   * Transfer colors from a pre-clean source shape through a `cleanShapeWithLineage`
   * cleanup's `BRepTools_History` onto the post-clean result. Use this when an
   * op is chained as `maker → cleanShape` — first apply `applyThroughMaker` to
   * move colors from the original source onto the pre-clean result, then call
   * this to chain them through the cleanup's UnifySameDomain history.
   */
  static applyThroughCleanup(source: Shape, cleanup: CleanShapeLineage) {
    for (const entry of source.colorMap) {
      const preFace = Face.fromTopoDSFace(Explorer.toFace(entry.shape));
      const postFaces = cleanup.remapFace(preFace);
      if (!postFaces) {
        continue;
      }
      for (const postFace of postFaces) {
        cleanup.shape.setColor(postFace.getShape(), entry.color);
      }
    }
  }
}
