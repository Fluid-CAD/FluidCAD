import { SceneObject } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { CleanShapeLineage, ShapeOps } from "../oc/shape-ops.js";
import { Plane } from "../math/plane.js";
import { classifyCutResult } from "./cut-helpers.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { Explorer } from "../oc/explorer.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { getOC } from "../oc/init.js";
import { ColorTransfer } from "../oc/color-transfer.js";
import type { TopAbs_ShapeEnum } from "occjs-wrapper";
import { Profiler } from "../common/profiler.js";

export function fuseWithSceneObjects(
  sceneObjects: SceneObject[],
  extrusions: Shape<any>[],
  opts?: { glue?: 'full' | 'shift'; recordHistoryFor?: SceneObject; profiler?: Profiler },
) {
  const p = opts?.profiler;
  const modified: { shape: Shape<any>, object: SceneObject }[] = [];

  const objShapeMap = new Map<Shape<any>, SceneObject>();
  for (const obj of sceneObjects) {
    const shapes = obj.getShapes({}, 'solid');
    for (const shape of shapes) {
      objShapeMap.set(shape, obj);
    }
  }

  let sceneShapes = Array.from(objShapeMap.keys());
  const fuseRun = () => BooleanOps.fuseStockAndTools(sceneShapes, extrusions, opts);
  const { result, newShapes, modifiedShapes, maker, dispose } = p
    ? p.record('Boolean fuse', fuseRun)
    : fuseRun();

  if (newShapes.length === 0 && modifiedShapes.length === 0) {
    dispose();
    if (opts?.recordHistoryFor) {
      const run = () => recordShapesAsAdditions(opts.recordHistoryFor!, extrusions);
      p ? p.record('Record fusion history', run) : run();
    }
    return {
      newShapes: extrusions,
      modifiedShapes: [],
    };
  }

  for (const shape of modifiedShapes) {
    const obj = objShapeMap.get(shape);
    modified.push({ shape, object: obj });
  }

  // Include all result shapes EXCEPT partners of scene object shapes
  // that survived the fuse (weren't consumed). Unconsumed scene shapes
  // stay on their original owners so we must not duplicate them.
  const unconsumed = sceneShapes.filter(s => !modifiedShapes.includes(s));
  const shapesToAdd = result.filter(s =>
    !unconsumed.some(u => u.getShape().IsPartner(s.getShape()))
  );

  let toolHistory: ShapeHistory | undefined;
  if (opts?.recordHistoryFor) {
    const recordHistory = () => {
      recordFusionHistory(opts.recordHistoryFor!, sceneShapes, objShapeMap, shapesToAdd, maker);
      // Separately track tool-side (extrusion) lineage so callers can remap
      // pre-fusion categorizations (start/end/side/…) onto the post-fusion
      // faces. We don't store these as modifications on any scene object —
      // from the user's POV they are additions on the caller already.
      toolHistory = ShapeHistoryTracker.collect(maker, extrusions);
    };
    p ? p.record('Record fusion history', recordHistory) : recordHistory();
  }

  dispose();
  return { newShapes: shapesToAdd, modifiedShapes: modified, toolHistory };
}

/**
 * Record faces/edges from each shape as additions on `caller`. Used when a
 * fusion was a no-op and the new geometry is added to the scene unchanged.
 */
function recordShapesAsAdditions(caller: SceneObject, shapes: Shape<any>[]) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  for (const shape of shapes) {
    for (const raw of Explorer.findShapes(shape.getShape(), FACE)) {
      caller.recordAddedFace(Face.fromTopoDSFace(Explorer.toFace(raw)), caller);
    }
    for (const raw of Explorer.findShapes(shape.getShape(), EDGE)) {
      caller.recordAddedEdge(Edge.fromTopoDSEdge(Explorer.toEdge(raw)), caller);
    }
  }
}

/**
 * Record modifications/removals on each scene-object owner, and additions on
 * the caller. Modifications are per-scene-shape so we can correctly attribute
 * each source face/edge back to its owning SceneObject.
 *
 * Additions: any face/edge in a new result shape that isn't already the target
 * of a scene-shape modification. This captures both extrusion-derived faces
 * (which appear in the result via tool-side Modified()) and truly new faces.
 */
function recordFusionHistory(
  caller: SceneObject,
  sceneShapes: Shape<any>[],
  owners: Map<Shape<any>, SceneObject>,
  newShapes: Shape<any>[],
  maker: any,
) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

  const claimedFaces = new oc.TopTools_MapOfShape();
  const claimedEdges = new oc.TopTools_MapOfShape();

  for (const sceneShape of sceneShapes) {
    const owner = owners.get(sceneShape);
    if (!owner) {
      continue;
    }
    const history = ShapeHistoryTracker.collect(maker, [sceneShape]);

    for (const record of history.modifiedFaces) {
      owner.recordModifiedFaces(record.sources, record.results, caller);
      for (const r of record.results) {
        claimedFaces.Add(r.getShape());
      }
    }
    for (const record of history.modifiedEdges) {
      owner.recordModifiedEdges(record.sources, record.results, caller);
      for (const r of record.results) {
        claimedEdges.Add(r.getShape());
      }
    }
    for (const face of history.removedFaces) {
      owner.recordRemovedFace(face, caller);
    }
    for (const edge of history.removedEdges) {
      owner.recordRemovedEdge(edge, caller);
    }
  }

  for (const newShape of newShapes) {
    for (const raw of Explorer.findShapes(newShape.getShape(), FACE)) {
      if (!claimedFaces.Contains(raw)) {
        caller.recordAddedFace(Face.fromTopoDSFace(Explorer.toFace(raw)), caller);
      }
    }
    for (const raw of Explorer.findShapes(newShape.getShape(), EDGE)) {
      if (!claimedEdges.Contains(raw)) {
        caller.recordAddedEdge(Edge.fromTopoDSEdge(Explorer.toEdge(raw)), caller);
      }
    }
  }

  ColorTransfer.applyThroughMaker(sceneShapes, newShapes, maker);
  ColorTransfer.applyBleeding(sceneShapes, newShapes, maker);

  claimedFaces.delete();
  claimedEdges.delete();
}

export function cutWithSceneObjects(
  sceneObjects: SceneObject[],
  toolShapes: Shape[],
  plane: Plane,
  distance: number,
  caller: SceneObject,
  options?: { recordHistoryFor?: SceneObject },
): { cleanedShapes: Shape[], stockShapes: Shape[] } {
  const sceneObjectMap = new Map<SceneObject, Shape[]>();
  for (const obj of sceneObjects) {
    const shapes = obj.getShapes({}, 'solid');
    if (shapes.length === 0) {
      continue;
    }
    sceneObjectMap.set(obj, shapes);
  }

  const shapeObjectMap = new Map<Shape, SceneObject>();
  for (const [obj, shapes] of sceneObjectMap) {
    for (const shape of shapes) {
      shapeObjectMap.set(shape, obj);
    }
  }

  const stock = Array.from(shapeObjectMap.keys());
  const cutResult = BooleanOps.cutMultiShape(stock, toolShapes, plane, distance);

  const cleanedShapes: Shape[] = [];
  const cleanups: CleanShapeLineage[] = [];
  for (const shape of stock) {
    const list = cutResult.modified(shape);
    if (list.length) {
      for (const newShape of list) {
        const cleanup = ShapeOps.cleanShapeWithLineage(newShape);
        caller.addShape(cleanup.shape as Solid);
        cleanedShapes.push(cleanup.shape);
        cleanups.push(cleanup);
      }

      const obj = shapeObjectMap.get(shape);
      obj.removeShape(shape, caller);
    }
  }

  if (options?.recordHistoryFor) {
    recordCutHistory(options.recordHistoryFor, stock, shapeObjectMap, cleanedShapes, cutResult.maker, cleanups);
  }

  for (const cleanup of cleanups) {
    cleanup.dispose();
  }
  cutResult.dispose();
  classifyCutResult(caller, stock, cleanedShapes, plane, distance);

  return { cleanedShapes, stockShapes: stock };
}

/**
 * Record per-owner modifications/removals and caller-side additions for a cut.
 * Mirrors the fusion variant but works with `BRepAlgoAPI_Cut`'s `Modified()` /
 * `IsDeleted()` semantics on stock faces and edges. Additions are the faces
 * and edges on the cleaned result shapes that aren't targets of any stock
 * modification — that covers the section faces/edges created by the cut plus
 * any tool-derived geometry that ended up in the result.
 */
function recordCutHistory(
  caller: SceneObject,
  stock: Shape<any>[],
  owners: Map<Shape<any>, SceneObject>,
  cleanedShapes: Shape<any>[],
  maker: any,
  cleanups: CleanShapeLineage[],
) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

  const claimedFaces = new oc.TopTools_MapOfShape();
  const claimedEdges = new oc.TopTools_MapOfShape();

  // Remap pre-clean faces through the UnifySameDomain history of whichever
  // cleanup handled them. Returns flattened post-clean faces.
  const remapPreCleanFaces = (preCleanFaces: Face[]): Face[] => {
    const out: Face[] = [];
    for (const face of preCleanFaces) {
      let matched = false;
      for (const cleanup of cleanups) {
        const remapped = cleanup.remapFace(face);
        if (remapped !== null) {
          out.push(...remapped);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // No cleanup claimed this face — it's somehow outside the cleaned
        // solids. Fall through as-is.
        out.push(face);
      }
    }
    return out;
  };

  const remapPreCleanEdges = (preCleanEdges: Edge[]): Edge[] => {
    const out: Edge[] = [];
    for (const edge of preCleanEdges) {
      let matched = false;
      for (const cleanup of cleanups) {
        const remapped = cleanup.remapEdge(edge);
        if (remapped !== null) {
          out.push(...remapped);
          matched = true;
          break;
        }
      }
      if (!matched) {
        out.push(edge);
      }
    }
    return out;
  };

  for (const stockShape of stock) {
    const owner = owners.get(stockShape);
    if (!owner) {
      continue;
    }
    const history = ShapeHistoryTracker.collect(maker, [stockShape]);

    for (const record of history.modifiedFaces) {
      const postCleanResults = remapPreCleanFaces(record.results);
      if (postCleanResults.length === 0) {
        // Entire modification was removed by UnifySameDomain — record as removal instead.
        for (const src of record.sources) {
          owner.recordRemovedFace(src, caller);
        }
        continue;
      }
      owner.recordModifiedFaces(record.sources, postCleanResults, caller);
      for (const r of postCleanResults) {
        claimedFaces.Add(r.getShape());
      }
    }
    for (const record of history.modifiedEdges) {
      const postCleanResults = remapPreCleanEdges(record.results);
      if (postCleanResults.length === 0) {
        for (const src of record.sources) {
          owner.recordRemovedEdge(src, caller);
        }
        continue;
      }
      owner.recordModifiedEdges(record.sources, postCleanResults, caller);
      for (const r of postCleanResults) {
        claimedEdges.Add(r.getShape());
      }
    }
    for (const face of history.removedFaces) {
      owner.recordRemovedFace(face, caller);
    }
    for (const edge of history.removedEdges) {
      owner.recordRemovedEdge(edge, caller);
    }
  }

  for (const cleaned of cleanedShapes) {
    for (const raw of Explorer.findShapes(cleaned.getShape(), FACE)) {
      if (!claimedFaces.Contains(raw)) {
        caller.recordAddedFace(Face.fromTopoDSFace(Explorer.toFace(raw)), caller);
      }
    }
    for (const raw of Explorer.findShapes(cleaned.getShape(), EDGE)) {
      if (!claimedEdges.Contains(raw)) {
        caller.recordAddedEdge(Edge.fromTopoDSEdge(Explorer.toEdge(raw)), caller);
      }
    }
  }

  propagateFaceColorsViaCut(stock, cleanedShapes, maker, cleanups);

  claimedFaces.delete();
  claimedEdges.delete();
}

/**
 * Cut-path color propagation. Chains through UnifySameDomain's history via
 * the `cleanups[]` remapFace callbacks so colors land on the actual
 * post-clean faces in `cleanedShapes`.
 */
function propagateFaceColorsViaCut(
  stock: Shape<any>[],
  cleanedShapes: Shape<any>[],
  maker: any,
  cleanups: CleanShapeLineage[],
) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;

  for (const stockShape of stock) {
    if (!stockShape.hasColors()) {
      continue;
    }

    for (const entry of stockShape.colorMap) {
      const modifiedRaws = ShapeOps.shapeListToArray(maker.Modified(entry.shape))
        .filter(s => s.ShapeType() === FACE);

      let preCleanFaces: Face[];
      if (modifiedRaws.length > 0) {
        preCleanFaces = modifiedRaws.map(r => Face.fromTopoDSFace(Explorer.toFace(r)));
      } else if (!maker.IsDeleted(entry.shape)) {
        preCleanFaces = [Face.fromTopoDSFace(Explorer.toFace(entry.shape))];
      } else {
        continue;
      }

      // Chain through each cleanup's UnifySameDomain lineage
      const postCleanFaces: Face[] = [];
      for (const preFace of preCleanFaces) {
        let matched = false;
        for (const cleanup of cleanups) {
          const remapped = cleanup.remapFace(preFace);
          if (remapped !== null) {
            postCleanFaces.push(...remapped);
            matched = true;
            break;
          }
        }
        if (!matched) {
          postCleanFaces.push(preFace);
        }
      }

      for (const postFace of postCleanFaces) {
        for (const cleaned of cleanedShapes) {
          const faces = Explorer.findShapes(cleaned.getShape(), FACE);
          if (faces.some(f => f.IsSame(postFace.getShape()))) {
            cleaned.setColor(postFace.getShape(), entry.color);
            break;
          }
        }
      }
    }
  }
}
