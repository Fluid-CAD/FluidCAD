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
   * geometry (tool inputs, generated faces, or just brand-new).
   *
   * Two passes, in order:
   *
   *   1. Lineage-based propagation. For each scene-source EDGE / VERTEX,
   *      ask `maker.Generated(input)` for the new face(s) it produced and
   *      color each generated face from the source face(s) that *contained*
   *      that input. This is what makes a fillet on a cylinder's top edge
   *      inherit the top face's color (the edge belongs to the top face) but
   *      a fillet on a box's vertical edge stay uncolored even when the top
   *      face is colored (the vertical edge belongs to two side faces only).
   *      Faces touched by this pass — colored OR not — are marked as
   *      lineage-resolved and excluded from pass 2.
   *
   *   2. Adjacency-based fallback for result faces that have no Generated
   *      lineage from any scene source (e.g. a fuse's tool-side faces, or
   *      brand-new section faces). These spread color via face-edge
   *      adjacency, iterating until stable. Faces that came from
   *      `sceneSources` (whether modified or unchanged) stay protected from
   *      both passes — those are explicit user choices.
   *
   * Call AFTER `applyThroughMaker` so the colored seeds are in place.
   */
  static applyBleeding(
    sceneSources: Shape[],
    results: Shape[],
    maker: BRepBuilderAPI_MakeShape,
  ) {
    if (!sceneSources.some(s => s.hasColors())) {
      return;
    }

    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const VERTEX = oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum;

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

      // ── Pass 1: lineage via Generated(edge|vertex) ──
      const lineageResolved = new oc.TopTools_MapOfShape();

      for (const scene of sceneSources) {
        const sceneFaces = Explorer.findShapes(scene.getShape(), FACE);

        for (const subType of [EDGE, VERTEX] as TopAbs_ShapeEnum[]) {
          // Cache scene-face → contained subshapes so we can find which faces
          // own a given edge/vertex without re-walking each time.
          const sceneFaceSubs = sceneFaces.map(f => Explorer.findShapes(f, subType));

          for (const sub of Explorer.findShapes(scene.getShape(), subType)) {
            const generatedFaces = ShapeOps.shapeListToArray(maker.Generated(sub))
              .filter(s => s.ShapeType() === FACE);
            if (generatedFaces.length === 0) {
              continue;
            }

            // Color the generated face from the first colored owner-face of
            // this edge/vertex. Owners with no color don't contribute, so a
            // fillet on a vertical box edge (owned only by uncolored sides)
            // stays uncolored even though the new fillet face touches a
            // colored top via adjacency.
            let pickedColor: string | undefined;
            for (let i = 0; i < sceneFaces.length; i++) {
              if (!sceneFaceSubs[i].some(s => s.IsSame(sub))) {
                continue;
              }
              const c = scene.getColor(sceneFaces[i]);
              if (c) {
                pickedColor = c;
                break;
              }
            }

            for (const g of generatedFaces) {
              if (!allFaces.some(rf => rf.IsSame(g))) {
                continue;
              }
              if (protectedFaces.Contains(g)) {
                continue;
              }
              lineageResolved.Add(g);
              if (pickedColor && !result.getColor(g)) {
                result.setColor(g, pickedColor);
              }
            }
          }
        }
      }

      // ── Pass 2: adjacency fallback for faces with no Generated lineage ──
      const faceEdges = allFaces.map(f => Explorer.findShapes(f, EDGE));

      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < allFaces.length; i++) {
          const face = allFaces[i];
          if (protectedFaces.Contains(face)) {
            continue;
          }
          if (lineageResolved.Contains(face)) {
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

      lineageResolved.delete();
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
