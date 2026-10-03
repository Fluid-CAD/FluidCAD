import { SceneObject } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { CleanShapeLineage, ShapeOps } from "../oc/shape-ops.js";
import { Plane } from "../math/plane.js";
import { classifyCutResult } from "./cut-helpers.js";
import { ShapeHistory, ShapeHistoryRecord, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { Explorer } from "../oc/explorer.js";
import { OrientedFaces } from "../oc/oriented-faces.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { getOC } from "../oc/init.js";
import { ColorTransfer } from "../oc/color-transfer.js";
import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { Profiler } from "../common/profiler.js";
import { Wire } from "../common/wire.js";
import { WireOps } from "../oc/wire-ops.js";
import { requireValidSolid } from "../oc/solid-validation.js";
import { RenderSeams } from "../oc/render-seams.js";
import { heldSolidsOf, type HeldSolid } from "./live-solids.js";

/**
 * The edges of the object's geometry, for the inputs that build a curve from
 * them. Meta shapes are never geometry — an axis datum's dashed line inside
 * the sketch (`mirror(yAxis())`) stays readable after the mirror hid it, and
 * must not become part of the curve.
 */
export function curveEdgesOf(obj: SceneObject): Edge[] {
  return obj.getShapes().flatMap(s => s.getSubShapes('edge')) as Edge[];
}

/**
 * Collects every edge of the object's shapes into one connected wire.
 * Used by path-style inputs that need a single curve (sweep paths).
 */
export function wireFromSceneObjectEdges(obj: SceneObject, label: string): Wire {
  const edges = curveEdgesOf(obj);
  if (edges.length === 0) {
    throw new Error(`${label} has no edges to build a curve from.`);
  }
  return WireOps.makeWireFromEdges(edges);
}

/**
 * Groups the object's edges into connected chains — one wire per chain.
 * Used by inputs that may carry several separate curves (e.g. a loft guide
 * sketch holding a curve and its mirror).
 */
export function wiresFromSceneObjectEdges(obj: SceneObject, label: string): Wire[] {
  const edges = curveEdgesOf(obj);
  if (edges.length === 0) {
    throw new Error(`${label} has no edges to build a curve from.`);
  }
  return WireOps.connectEdgesToWires(edges);
}


export function fuseWithSceneObjects(
  sceneObjects: SceneObject[],
  extrusions: Shape<any>[],
  opts?: { glue?: 'full' | 'shift'; recordHistoryFor?: SceneObject; profiler?: Profiler; skipSimplify?: boolean; validateResult?: boolean },
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

  // An empty or errored fuse must not be adopted: the callers would remove
  // the consumed stock and add nothing, silently emptying the scene.
  const verdict = BooleanOps.diagnoseFuseResult(result, modifiedShapes, maker);
  if (verdict.ok === false) {
    dispose();
    const label = opts?.recordHistoryFor ? opts.recordHistoryFor.getType() : 'fuse';
    throw new Error(
      `${label}: fusing the new body into the existing solid failed — ${verdict.reason}. `
      + 'The new body is probably self-intersecting, inverted or only touches the '
      + 'existing solid along a sliver; the existing solids were left unchanged.',
    );
  }

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

  // Clean each addition with UnifySameDomain so that coplanar wall pieces
  // split by the boolean fuse merge back into single faces (the visible
  // "artifact seams" on the target solid). Lineage is captured per cleanup
  // so downstream history can be remapped onto post-clean faces.
  // If a consumed body carried delicate same-domain geometry (e.g. thread
  // flanks from a helix sweep), skip the global face-merge so the fuse doesn't
  // collapse it, and re-flag the result so later ops keep skipping too.
  const skipSimplify = opts?.skipSimplify || modifiedShapes.some(s => s.noSimplify());
  const cleanedShapesToAdd: Shape<any>[] = [];
  const cleanups: CleanShapeLineage[] = [];
  try {
    const runCleanups = () => {
      for (const shape of shapesToAdd) {
        if (opts?.validateResult) requireValidSolid(shape.getShape(), "Sweep fuse result");
        RenderSeams.throughHistory(shape, [...sceneShapes, ...extrusions], maker);
        const cleanup = ShapeOps.cleanShapeWithLineage(shape, { skipSimplify, unifyEdges: true, requireLineage: opts?.validateResult });
        cleanups.push(cleanup);
        if (opts?.validateResult && !cleanup.shape.getShape().IsEqual(shape.getShape())) {
          requireValidSolid(cleanup.shape.getShape(), "Sweep fuse cleanup");
        }
        if (skipSimplify) {
          cleanup.shape.markNoSimplify();
        }
        cleanedShapesToAdd.push(cleanup.shape);
      }
    };
    p ? p.record('Clean fuse result', runCleanups) : runCleanups();

    let toolHistory: ShapeHistory | undefined;
    if (opts?.recordHistoryFor) {
      const recordHistory = () => {
        // One in-result orientation index over the fuse output, shared by every
        // history collect below (scene-side per shape, then tool-side).
        const resultFaces = new OrientedFaces(maker.Shape());
        try {
          recordFusionHistory(
            opts.recordHistoryFor!, sceneShapes, objShapeMap, cleanedShapesToAdd, maker, cleanups, resultFaces, p,
          );
          // Separately track tool-side (extrusion) lineage so callers can remap
          // pre-fusion categorizations (start/end/side/…) onto the post-fusion
          // faces. Tool-side history is only consumed by `remapClassifiedFaces`,
          // which touches modifiedFaces only — skip the added* output traversal.
          const collectTools = () => ShapeHistoryTracker.collect(maker, extrusions, { skipAdded: true, resultFaces });
          const rawToolHistory = p ? p.record('Collect tool history', collectTools) : collectTools();
          toolHistory = remapHistoryThroughCleanups(rawToolHistory, cleanups, extrusions);
        } finally {
          resultFaces.delete();
        }
      };
      p ? p.record('Record fusion history', recordHistory) : recordHistory();
    }

    return { newShapes: cleanedShapesToAdd, modifiedShapes: modified, toolHistory };
  } finally {
    for (const cleanup of cleanups) cleanup.dispose();
    dispose();
  }
}

// Remap a pre-clean history through a set of cleanup lineages. Modified
// records get their result faces/edges replaced with the post-clean image;
// records whose results entirely vanish during cleanup are dropped (the
// caller will have already recorded removals for the corresponding sources).
// `inputs` are the maker's inputs the history was collected for: the
// sub-shapes the boolean left alone but a cleanup rebuilt get a record too.
function remapHistoryThroughCleanups(
  history: ShapeHistory,
  cleanups: CleanShapeLineage[],
  inputs: Shape[] = [],
): ShapeHistory {
  const remapFaces = (faces: Face[]): Face[] =>
    faces.flatMap(f => remapThroughCleanups(f, cleanups, (c, face) => c.remapFace(face)));
  const remapEdges = (edges: Edge[]): Edge[] =>
    edges.flatMap(e => remapThroughCleanups(e, cleanups, (c, edge) => c.remapEdge(edge)));

  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  const cleanupOnlyFaces = cleanupOnlyRecords(
    inputs, FACE, history.modifiedFaces, history.removedFaces,
    raw => Face.fromTopoDSFace(Explorer.toFace(raw)), face => remapFaces([face]),
  );
  const cleanupOnlyEdges = cleanupOnlyRecords(
    inputs, EDGE, history.modifiedEdges, history.removedEdges,
    raw => Edge.fromTopoDSEdge(Explorer.toEdge(raw)), edge => remapEdges([edge]),
  );

  return {
    addedFaces: remapFaces(history.addedFaces),
    modifiedFaces: [
      ...history.modifiedFaces
        .map(r => ({ sources: r.sources, results: remapFaces(r.results) }))
        .filter(r => r.results.length > 0),
      ...cleanupOnlyFaces,
    ],
    generatedFaces: history.generatedFaces.map(r => ({
      sources: r.sources,
      results: remapFaces(r.results),
    })),
    removedFaces: history.removedFaces,
    addedEdges: remapEdges(history.addedEdges),
    modifiedEdges: [
      ...history.modifiedEdges
        .map(r => ({ sources: r.sources, results: remapEdges(r.results) }))
        .filter(r => r.results.length > 0),
      ...cleanupOnlyEdges,
    ],
    generatedEdges: history.generatedEdges.map(r => ({
      sources: r.sources,
      results: remapEdges(r.results),
    })),
    removedEdges: history.removedEdges,
  };
}

/**
 * Modified records for the sub-shapes of `inputs` the boolean left alone but
 * a cleanup rebuilt. A maker's history only knows what the boolean touched;
 * UnifySameDomain's edge merge then re-creates every face bounded by a
 * merged edge (a prism whose profile carried a circle's seam vertex has its
 * caps rebuilt when the two seam arcs unify), and a bucket or lineage that
 * follows the maker's records alone loses those faces. Sub-shapes that
 * already have a modified or removed record are skipped — the caller
 * remaps those records itself — as are the ones the cleanup kept as-is.
 */
function cleanupOnlyRecords<T extends Shape>(
  inputs: Shape[],
  type: TopAbs_ShapeEnum,
  modified: ShapeHistoryRecord<T>[],
  removed: T[],
  wrap: (raw: TopoDS_Shape) => T,
  remap: (item: T) => T[],
): ShapeHistoryRecord<T>[] {
  if (inputs.length === 0) {
    return [];
  }
  const oc = getOC();
  const recorded = new oc.TopTools_MapOfShape();
  try {
    for (const record of modified) {
      for (const source of record.sources) {
        recorded.Add(source.getShape());
      }
    }
    for (const shape of removed) {
      recorded.Add(shape.getShape());
    }
    const records: ShapeHistoryRecord<T>[] = [];
    for (const input of inputs) {
      for (const raw of Explorer.findShapes(input.getShape(), type)) {
        if (recorded.Contains(raw)) {
          continue;
        }
        const source = wrap(raw);
        const images = remap(source);
        if (images.length === 1 && images[0].getShape().IsSame(raw)) {
          continue;
        }
        records.push({ sources: [source], results: images });
      }
    }
    return records;
  } finally {
    recorded.delete();
  }
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
 * Additions: any face/edge in a new result shape that descends from no scene
 * shape — neither a face/edge of one that came through as it was, nor the
 * target of a scene-shape modification. This captures both extrusion-derived
 * faces (which appear in the result via tool-side Modified()) and truly new
 * faces.
 */
function recordFusionHistory(
  caller: SceneObject,
  sceneShapes: Shape<any>[],
  owners: Map<Shape<any>, SceneObject>,
  newShapes: Shape<any>[],
  maker: any,
  cleanups: CleanShapeLineage[],
  resultFaces: OrientedFaces,
  p?: Profiler,
) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

  const claimedFaces = new oc.TopTools_MapOfShape();
  const claimedEdges = new oc.TopTools_MapOfShape();

  // Remap pre-clean faces/edges through whichever cleanup handled them,
  // mirroring the cut-side helper. Faces no cleanup knew about pass through.
  const remapFaces = (faces: Face[]): Face[] => {
    const out: Face[] = [];
    for (const face of faces) {
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
        out.push(face);
      }
    }
    return out;
  };

  const remapEdges = (edges: Edge[]): Edge[] => {
    const out: Edge[] = [];
    for (const edge of edges) {
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

  const collectScene = () => {
    for (const sceneShape of sceneShapes) {
      const owner = owners.get(sceneShape);
      if (!owner) {
        continue;
      }
      // A stock face or edge the fuse hands back as it was is the stock's
      // still, and stays with whoever added it: each claims itself, so the
      // additions below are left with what descends from no stock sub-shape.
      for (const raw of Explorer.findShapes(sceneShape.getShape(), FACE)) {
        claimedFaces.Add(raw);
      }
      for (const raw of Explorer.findShapes(sceneShape.getShape(), EDGE)) {
        claimedEdges.Add(raw);
      }
      // recordFusionHistory aggregates additions across the full result via
      // `claimedFaces`/`claimedEdges` below — each per-shape collect doesn't
      // need to compute its own added* sets.
      const history = ShapeHistoryTracker.collect(maker, [sceneShape], { skipAdded: true, resultFaces });

      for (const record of history.modifiedFaces) {
        const postCleanResults = remapFaces(record.results);
        if (postCleanResults.length === 0) {
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
        const postCleanResults = remapEdges(record.results);
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
      // Stock faces/edges the boolean left alone but a cleanup rebuilt keep
      // their lineage too — see cleanupOnlyRecords.
      const stockFaces = cleanupOnlyRecords(
        [sceneShape], FACE, history.modifiedFaces, history.removedFaces,
        raw => Face.fromTopoDSFace(Explorer.toFace(raw)), face => remapFaces([face]),
      );
      for (const record of stockFaces) {
        if (record.results.length === 0) {
          owner.recordRemovedFace(record.sources[0], caller);
          continue;
        }
        owner.recordModifiedFaces(record.sources, record.results, caller);
        for (const r of record.results) {
          claimedFaces.Add(r.getShape());
        }
      }
      const stockEdges = cleanupOnlyRecords(
        [sceneShape], EDGE, history.modifiedEdges, history.removedEdges,
        raw => Edge.fromTopoDSEdge(Explorer.toEdge(raw)), edge => remapEdges([edge]),
      );
      for (const record of stockEdges) {
        if (record.results.length === 0) {
          owner.recordRemovedEdge(record.sources[0], caller);
          continue;
        }
        owner.recordModifiedEdges(record.sources, record.results, caller);
        for (const r of record.results) {
          claimedEdges.Add(r.getShape());
        }
      }
    }
  };
  p ? p.record('Collect scene history', collectScene) : collectScene();

  const recordAdditions = () => {
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
  };
  p ? p.record('Record additions', recordAdditions) : recordAdditions();

  const remapRawFace = (raw: TopoDS_Shape): TopoDS_Shape[] =>
    remapFaces([Face.fromTopoDSFace(Explorer.toFace(raw))]).map(f => f.getShape());

  const colorThrough = () => ColorTransfer.applyThroughMaker(sceneShapes, newShapes, maker, remapRawFace);
  p ? p.record('Color through maker', colorThrough) : colorThrough();

  const colorBleed = () => ColorTransfer.applyBleeding(sceneShapes, newShapes, maker, remapRawFace);
  p ? p.record('Color bleeding', colorBleed) : colorBleed();

  claimedFaces.delete();
  claimedEdges.delete();
}

/**
 * Record a single-solid modifier's maker history (fillet/chamfer/draft):
 * modifications and removals land on the input solid's previous owner with
 * `modifiedBy = caller`, everything the maker created lands on the caller as
 * additions — the counterpart of `recordFusionHistory` for ops whose maker
 * reports its own history. `remaps` chains the records through post-op
 * cleanups (UnifySameDomain): a merged-away result drops from its record
 * (sources become removals), a sub-shape a cleanup never saw passes through
 * unchanged.
 */
export function recordModifierHistory(
  history: ShapeHistory,
  owner: SceneObject,
  caller: SceneObject,
  remaps: CleanShapeLineage[] = [],
): void {
  const remapFace = (face: Face): Face[] => {
    for (const r of remaps) {
      const mapped = r.remapFace(face);
      if (mapped !== null) {
        return mapped;
      }
    }
    return [face];
  };
  const remapEdge = (edge: Edge): Edge[] => {
    for (const r of remaps) {
      const mapped = r.remapEdge(edge);
      if (mapped !== null) {
        return mapped;
      }
    }
    return [edge];
  };

  for (const record of history.modifiedFaces) {
    const results = record.results.flatMap(remapFace);
    if (results.length === 0) {
      for (const src of record.sources) {
        owner.recordRemovedFace(src, caller);
      }
      continue;
    }
    owner.recordModifiedFaces(record.sources, results, caller);
  }
  for (const record of history.modifiedEdges) {
    const results = record.results.flatMap(remapEdge);
    if (results.length === 0) {
      for (const src of record.sources) {
        owner.recordRemovedEdge(src, caller);
      }
      continue;
    }
    owner.recordModifiedEdges(record.sources, results, caller);
  }
  for (const face of history.removedFaces) {
    owner.recordRemovedFace(face, caller);
  }
  for (const edge of history.removedEdges) {
    owner.recordRemovedEdge(edge, caller);
  }

  // Generated results (e.g. the fillet surfaces born from the filleted edges)
  // are new geometry exactly like the unclaimed additions.
  const newFaces = [...history.addedFaces, ...history.generatedFaces.flatMap(r => r.results)];
  for (const face of newFaces.flatMap(remapFace)) {
    caller.recordAddedFace(face, caller);
  }
  const newEdges = [...history.addedEdges, ...history.generatedEdges.flatMap(r => r.results)];
  for (const edge of newEdges.flatMap(remapEdge)) {
    caller.recordAddedEdge(edge, caller);
  }
}

/**
 * The stock a boolean helper is handed: scope objects (every solid they hold
 * now), or solids already resolved to their holders
 * (`SceneObject.resolveFusionStock`).
 */
function stockOf(scope: SceneObject[] | HeldSolid[]): HeldSolid[] {
  return scope.every(entry => entry instanceof SceneObject)
    ? heldSolidsOf(scope as SceneObject[])
    : scope as HeldSolid[];
}

export function cutWithSceneObjects(
  scope: SceneObject[] | HeldSolid[],
  toolShapes: Shape[],
  plane: Plane,
  distance: number,
  caller: SceneObject,
  options?: {
    recordHistoryFor?: SceneObject;
    skipSimplify?: boolean;
    /** Runtime sweep validation, before any scene changes are applied. */
    validateResult?: boolean;
    /** The tool sweeps away from `plane` on both sides (symmetric / two-distance); see `classifyCutEdges`. */
    bidirectional?: boolean;
    /**
     * Solids the cut leaves alone whichever scope object carries them — a
     * part container hands out its children's solids too, so leaving an
     * object out of `scope` does not keep its solids out of the stock.
     */
    excludeStock?: Shape[];
  },
): { cleanedShapes: Shape[], stockShapes: Shape[] } {
  const excluded = options?.excludeStock ?? [];
  const shapeObjectMap = new Map<Shape, SceneObject>();
  for (const { holder, solid } of stockOf(scope)) {
    if (!excluded.some(other => other === solid || other.getShape().IsSame(solid.getShape()))) {
      shapeObjectMap.set(solid, holder);
    }
  }

  const stock = Array.from(shapeObjectMap.keys());
  // An empty stock list makes BRepAlgoAPI_Cut report a bare kernel error —
  // refuse it here with the actual problem instead.
  if (stock.length === 0) {
    throw new Error(
      `${caller.getType()} has nothing to remove — no solid is in scope. `
      + 'Add material first (e.g. extrude a profile), or move this feature '
      + 'into the part() that owns the solid it should cut.',
    );
  }
  const cutResult = BooleanOps.cutMultiShape(stock, toolShapes, plane, distance,
    { validate: options?.validateResult, stage: `${caller.getType()} cut result` });

  const cleanedShapes: Shape[] = [];
  const cleanups: CleanShapeLineage[] = [];
  const replacedStock: Shape[] = [];
  // What each replaced stock solid became — none when cut away entirely.
  const successors = new Map<Shape, Shape[]>();
  try {
    for (const shape of stock) {
      const list = cutResult.modified(shape);
      if (list.length) {
        // Global face unification would collapse delicate same-domain geometry
        // (e.g. thread flanks) the stock already carries, so skip it when the
        // caller asked to or when the stock is flagged, and re-flag the result.
        const skipSimplify = options?.skipSimplify || shape.noSimplify();
        const made: Shape[] = [];
        for (const newShape of list) {
          RenderSeams.throughHistory(newShape, [shape, ...toolShapes], cutResult.makerOf(shape));
          const cleanup = ShapeOps.cleanShapeWithLineage(newShape, { skipSimplify, unifyEdges: true,
            requireLineage: options?.validateResult });
          cleanups.push(cleanup);
          if (options?.validateResult && !cleanup.shape.getShape().IsEqual(newShape.getShape())) {
            requireValidSolid(cleanup.shape.getShape(), `${caller.getType()} cut cleanup`);
          }
          if (skipSimplify) {
            cleanup.shape.markNoSimplify();
          }
          cleanedShapes.push(cleanup.shape);
          made.push(cleanup.shape);
        }

        replacedStock.push(shape);
        successors.set(shape, made);
      } else if (cutResult.makerOf(shape).IsDeleted(shape.getShape())) {
        replacedStock.push(shape);
        successors.set(shape, []);
      }
    }

    // Validate every replacement before adopting any. Complete removal has no
    // replacement solid; a stock the cut left as it was — out of the tool's
    // reach, or only touched by it — has neither, and stays the solid it is
    // on the object that owns it.
    for (const shape of cleanedShapes) caller.addShape(shape as Solid);
    for (const shape of replacedStock) shapeObjectMap.get(shape)!.removeShape(shape, caller, successors.get(shape));

    // The geometry the cut created — every result face/edge that is neither a
    // stock sub-shape nor the boolean's Modified() image of one — carried
    // across the cleanup so the history and the classification point at
    // sub-shapes the caller now owns. See `classifyCutResult` for why this is
    // kernel history rather than a geometric comparison against the stock.
    const internalFaces = remapCreated(cutResult.internalFaces, cleanups, (c, f) => c.remapFace(f));
    const sectionEdges = remapCreated(cutResult.sectionEdges, cleanups, (c, e) => c.remapEdge(e));

    if (options?.recordHistoryFor) {
      recordCutHistory(options.recordHistoryFor, replacedStock, shapeObjectMap, cleanedShapes, cutResult.makerOf,
        cleanups, internalFaces, sectionEdges);
    }

    classifyCutResult(caller, cleanedShapes, sectionEdges, internalFaces, plane, distance, options?.bidirectional === true);

    return { cleanedShapes, stockShapes: stock };
  } finally {
    for (const cleanup of cleanups) cleanup.dispose();
    cutResult.dispose();
  }
}

/**
 * Carry pre-clean sub-shapes through whichever cleanup lineage claims them,
 * dropping the ones the cleanup removed and merging duplicates
 * (UnifySameDomain maps several pre-clean sub-shapes onto one merged one).
 * A sub-shape no cleanup knows is kept as-is.
 */
function remapCreated<T extends Shape>(
  items: T[],
  cleanups: CleanShapeLineage[],
  remap: (cleanup: CleanShapeLineage, item: T) => T[] | null,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    for (const r of remapThroughCleanups(item, cleanups, remap)) {
      if (!out.some(existing => existing.getShape().IsSame(r.getShape()))) {
        out.push(r);
      }
    }
  }
  return out;
}

function remapThroughCleanups<T>(
  item: T,
  cleanups: CleanShapeLineage[],
  remap: (cleanup: CleanShapeLineage, item: T) => T[] | null,
): T[] {
  for (const cleanup of cleanups) {
    const remapped = remap(cleanup, item);
    if (remapped !== null) {
      return remapped;
    }
  }
  return [item];
}

/**
 * Record per-owner modifications/removals and caller-side additions for a cut.
 * Mirrors the fusion variant but works with `BRepAlgoAPI_Cut`'s `Modified()` /
 * `IsDeleted()` semantics on stock faces and edges. `stock` holds the stocks
 * the cut replaced, each read through the boolean that ran against it.
 *
 * Additions are `createdFaces` / `createdEdges` — the geometry the cut made
 * (see `BooleanOps.cutMultiShape`), already on the cleaned result. A stock
 * face or edge that came through as it was stays with whoever added it, and
 * one that only a cleanup rebuilt keeps its lineage as a modification on its
 * owner; neither is the caller's. A created face a cleanup merged into a
 * stock face descends from that face, so it is recorded once, as the
 * modification.
 */
function recordCutHistory(
  caller: SceneObject,
  stock: Shape<any>[],
  owners: Map<Shape<any>, SceneObject>,
  cleanedShapes: Shape<any>[],
  makerOf: (stockShape: Shape<any>) => any,
  cleanups: CleanShapeLineage[],
  createdFaces: Face[],
  createdEdges: Edge[],
) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

  const claimedFaces = new oc.TopTools_MapOfShape();
  const claimedEdges = new oc.TopTools_MapOfShape();

  // Remap pre-clean faces/edges through the UnifySameDomain history of
  // whichever cleanup handled them. Returns flattened post-clean shapes.
  const remapPreCleanFaces = (preCleanFaces: Face[]): Face[] =>
    preCleanFaces.flatMap(face => remapThroughCleanups(face, cleanups, (c, f) => c.remapFace(f)));
  const remapPreCleanEdges = (preCleanEdges: Edge[]): Edge[] =>
    preCleanEdges.flatMap(edge => remapThroughCleanups(edge, cleanups, (c, e) => c.remapEdge(e)));

  for (const stockShape of stock) {
    const owner = owners.get(stockShape);
    if (!owner) {
      continue;
    }
    // The caller's additions are handed in, so each per-shape collect can
    // skip its own added* output traversal.
    const history = ShapeHistoryTracker.collect(makerOf(stockShape), [stockShape], { skipAdded: true });

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
    // Stock faces/edges the boolean left alone but a cleanup rebuilt keep
    // their lineage too — see cleanupOnlyRecords.
    const stockFaces = cleanupOnlyRecords(
      [stockShape], FACE, history.modifiedFaces, history.removedFaces,
      raw => Face.fromTopoDSFace(Explorer.toFace(raw)), face => remapPreCleanFaces([face]),
    );
    for (const record of stockFaces) {
      if (record.results.length === 0) {
        owner.recordRemovedFace(record.sources[0], caller);
        continue;
      }
      owner.recordModifiedFaces(record.sources, record.results, caller);
      for (const r of record.results) {
        claimedFaces.Add(r.getShape());
      }
    }
    const stockEdges = cleanupOnlyRecords(
      [stockShape], EDGE, history.modifiedEdges, history.removedEdges,
      raw => Edge.fromTopoDSEdge(Explorer.toEdge(raw)), edge => remapPreCleanEdges([edge]),
    );
    for (const record of stockEdges) {
      if (record.results.length === 0) {
        owner.recordRemovedEdge(record.sources[0], caller);
        continue;
      }
      owner.recordModifiedEdges(record.sources, record.results, caller);
      for (const r of record.results) {
        claimedEdges.Add(r.getShape());
      }
    }
  }

  for (const face of createdFaces) {
    if (!claimedFaces.Contains(face.getShape())) {
      caller.recordAddedFace(face, caller);
    }
  }
  for (const edge of createdEdges) {
    if (!claimedEdges.Contains(edge.getShape())) {
      caller.recordAddedEdge(edge, caller);
    }
  }

  propagateFaceColorsViaCut(stock, cleanedShapes, makerOf, cleanups);

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
  makerOf: (stockShape: Shape<any>) => any,
  cleanups: CleanShapeLineage[],
) {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;

  for (const stockShape of stock) {
    if (!stockShape.hasColors()) {
      continue;
    }

    const maker = makerOf(stockShape);
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
