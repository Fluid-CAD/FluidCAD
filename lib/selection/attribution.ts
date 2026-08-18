import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { SelectionIndex, BucketHit, SubShapeKind } from "./selection-index.js";
import { PickRef, SelectionScene } from "./types.js";

export type LineageInfo = {
  /** Classified ancestor's bucket, when one was found walking history back. */
  classified: BucketHit | null;
  /**
   * Set instead of `classified` when the walk ended on an ancestor claimed by
   * a creator (added-sub-shape) record rather than a bucket — e.g. a fillet
   * arc face that a later fillet trimmed. A classified ancestor anywhere in
   * the walk wins over a creator hit: pass-through fusions re-record surviving
   * sub-shapes as their own additions, so creator claims are the weaker signal.
   */
  creator: SceneObject | null;
  /** Features that modified the sub-shape between classification and now. */
  modifiedBy: SceneObject[];
};

export type PickAttribution = {
  ref: PickRef;
  /** The concrete sub-shape wrapper on the rendered solid, if resolved. */
  picked: Shape | null;
  pickedKey: number | null;
  /** The SceneObject whose added shape owns the rendered solid. */
  solidOwner: SceneObject | null;
  /** The rendered solid the pick was resolved against. */
  solidShape: Shape | null;
  /** Classified origin — the winning bucket hit, if any. */
  producer: BucketHit | null;
  /** Set when no bucket contains the pick but lineage found an ancestor. */
  lineage: LineageInfo | null;
  /**
   * The feature whose added-sub-shape record claims the pick directly, when
   * neither a bucket nor lineage resolves it — e.g. an untouched fillet arc
   * face. Creation provenance only; never feeds selector synthesis.
   */
  creator: SceneObject | null;
  error?: string;
};

const LINEAGE_MAX_DEPTH = 8;

/**
 * Resolve a pick to the concrete sub-shape it refers to, using the same
 * exploration order the mesh was baked with (`Explorer.find*Wrapped`), then
 * reverse-look it up in the classified buckets. Pure read over a built scene.
 */
export function attributePick(scene: SelectionScene, index: SelectionIndex, ref: PickRef): PickAttribution {
  const none: PickAttribution = {
    ref, picked: null, pickedKey: null, solidOwner: null, solidShape: null, producer: null, lineage: null, creator: null,
  };

  const resolved = resolvePickShape(scene, ref);
  if (!resolved) {
    return { ...none, error: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const pickedKey = index.keyOf(resolved.sub);
  const hits = index.findHits(pickedKey, ref.sub.type);
  const producer = hits.length > 0 ? hits[0] : null;
  const lineage = producer ? null : findLineage(scene, index, pickedKey, ref.sub.type);
  // Direct creator claims rank below lineage: a pass-through fusion re-records
  // a surviving (possibly earlier-modified) sub-shape as its own addition, and
  // only the modification walk sees past that.
  const creator = producer || lineage ? null : index.creatorOf(pickedKey);

  return {
    ref,
    picked: resolved.sub,
    pickedKey,
    solidOwner: resolved.owner,
    solidShape: resolved.shape,
    producer,
    lineage,
    creator,
  };
}

export function resolvePickShape(
  scene: SelectionScene,
  ref: PickRef,
): { owner: SceneObject; shape: Shape; sub: Shape } | null {
  for (const obj of scene.getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes()) {
      if (shape.id !== ref.shapeId) {
        continue;
      }
      const subs = ref.sub.type === 'face'
        ? Explorer.findFacesWrapped(shape)
        : Explorer.findEdgesWrapped(shape);
      if (ref.sub.index < 0 || ref.sub.index >= subs.length) {
        return null;
      }
      return { owner: obj, shape, sub: subs[ref.sub.index] };
    }
  }
  return null;
}

/**
 * Walk the `modifiedEdges`/`modifiedFaces` records backwards (results →
 * sources) looking for a classified ancestor of the picked sub-shape.
 * Phase-1 consumers use this only to explain *why* a pick is unattributable;
 * an ancestor's accessor would resolve to the pre-modification shape, which
 * no longer exists on the final solid.
 */
function findLineage(
  scene: SelectionScene,
  index: SelectionIndex,
  pickedKey: number,
  kind: SubShapeKind,
): LineageInfo | null {
  type ModRecord = { resultKeys: Set<number>; sources: Shape[]; modifiedBy: SceneObject };
  const records: ModRecord[] = [];
  for (const obj of scene.getAllSceneObjects()) {
    const recs = kind === 'edge' ? obj.getModifiedEdges() : obj.getModifiedFaces();
    for (const rec of recs) {
      records.push({
        resultKeys: new Set(rec.results.map((r: Shape) => index.keyOf(r))),
        sources: rec.sources,
        modifiedBy: rec.modifiedBy,
      });
    }
  }
  if (records.length === 0) {
    return null;
  }

  const visited = new Set<number>([pickedKey]);
  let frontier: { key: number; chain: SceneObject[] }[] = [{ key: pickedKey, chain: [] }];
  // A classified ancestor anywhere in the walk beats a creator claim at any
  // depth (creator claims are polluted by pass-through fusion re-additions),
  // so a creator hit is only remembered while the walk keeps going.
  let creatorCandidate: { creator: SceneObject; modifiedBy: SceneObject[] } | null = null;

  for (let depth = 0; depth < LINEAGE_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { key, chain } of frontier) {
      for (const rec of records) {
        if (!rec.resultKeys.has(key)) {
          continue;
        }
        const newChain = [rec.modifiedBy, ...chain];
        for (const source of rec.sources) {
          const sourceKey = index.keyOf(source);
          if (visited.has(sourceKey)) {
            continue;
          }
          visited.add(sourceKey);
          const hits = index.findHits(sourceKey, kind);
          if (hits.length > 0) {
            return { classified: hits[0], creator: null, modifiedBy: newChain };
          }
          if (!creatorCandidate) {
            const creator = index.creatorOf(sourceKey);
            if (creator) {
              creatorCandidate = { creator, modifiedBy: newChain };
            }
          }
          next.push({ key: sourceKey, chain: newChain });
        }
      }
    }
    frontier = next;
  }

  if (creatorCandidate) {
    return { classified: null, creator: creatorCandidate.creator, modifiedBy: creatorCandidate.modifiedBy };
  }
  return null;
}
