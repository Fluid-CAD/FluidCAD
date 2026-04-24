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
