import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { TangentExpander } from "../filters/tangent-expander.js";
import { attributePick, resolvePickShape } from "./attribution.js";
import { BucketRecord, SelectionIndex } from "./selection-index.js";
import { PickRef, PickSubRef, SelectionScene } from "./types.js";

export type ExpandTangentsResult =
  | { ok: true; members: PickRef[] }
  | { ok: false; reason: string };

export type ExpandBucketResult =
  | {
    ok: true;
    members: PickRef[];
    /** The classifying feature's type, e.g. `extrude` or `cut`. */
    featureType: string;
    /** The bucket's public accessor, e.g. `endEdges`. */
    accessor: string;
  }
  | { ok: false; reason: string };

/** The sub-shape universe a pick's mesh indices are defined over. */
function pickUniverse(shape: Shape, kind: PickSubRef['type']): Shape[] {
  if (kind === 'vertex') {
    return [];
  }
  return kind === 'face'
    ? Explorer.findFacesWrapped(shape)
    : Explorer.findEdgesWrapped(shape);
}

/** Sorted universe indices → pick refs on the picked shape. */
function toPickRefs(ref: PickRef, indices: number[]): PickRef[] {
  return [...indices]
    .sort((a, b) => a - b)
    .map(index => ({ shapeId: ref.shapeId, sub: { type: ref.sub.type, index } }));
}

/**
 * Every solid the scene renders, in scene order. Removals count when their
 * remover is in the scene: a boundary-scoped view keeps the solids a later
 * statement consumes, exactly as its rollback draws them.
 */
function renderedSolids(scene: SelectionScene): Shape[] {
  const objects = scene.getAllSceneObjects();
  const removalScope = new Set(objects);
  return objects
    .filter(obj => !obj.isContainer())
    .flatMap(obj => obj.getShapes({}, 'solid', removalScope));
}

/**
 * Every face (or edge) the scene renders, as the pick ref that names it and
 * its `IsSame`-consistent key, in scene then mesh order — built once, then
 * shared by every bucket lookup of one query.
 */
export type PickUniverse = { ref: PickRef; key: number }[];

export function buildPickUniverse(scene: SelectionScene, index: SelectionIndex, kind: PickSubRef['type']): PickUniverse {
  const universe: PickUniverse = [];
  for (const solid of renderedSolids(scene)) {
    pickUniverse(solid, kind).forEach((shape, universeIndex) => {
      universe.push({ ref: { shapeId: solid.id, sub: { type: kind, index: universeIndex } }, key: index.keyOf(shape) });
    });
  }
  return universe;
}

/**
 * A bucket's surviving members across every rendered solid, as pick refs in
 * universe order. The accessor the bucket backs (`e.startFaces()`) names
 * every member wherever it lives, so a feature that built several bodies at
 * once (a region extrude) expands to all of them. Bucket members are
 * as-built wrappers; the hash keys bridge them onto each solid's mesh-order
 * universe, so members a later boolean consumed are skipped naturally.
 */
export function bucketMembers(universe: PickUniverse, bucket: BucketRecord): PickRef[] {
  const memberKeys = new Set(bucket.memberKeys);
  return universe.filter(entry => memberKeys.has(entry.key)).map(entry => entry.ref);
}

/**
 * Expand a picked edge (or face) to its full tangent chain on the owning
 * solid — the "Select with tangents" gesture. Returns every chain member as
 * a pick ref in mesh exploration order (the seed included), so the UI can
 * highlight them exactly like ordinary picks.
 */
export function expandTangentChain(scene: SelectionScene, ref: PickRef): ExpandTangentsResult {
  if (ref.sub.type === 'vertex') {
    return { ok: false, reason: 'Tangent chains require faces or edges.' };
  }
  const resolved = resolvePickShape(scene, ref);
  if (!resolved) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const universe = pickUniverse(resolved.shape, ref.sub.type);
  // Seed with the universe's own wrapper so expansion results stay
  // identity-mappable back to mesh indices.
  const seed = universe[ref.sub.index];
  const expanded = TangentExpander.expand([seed], universe);

  const indexByWrapper = new Map<Shape, number>();
  universe.forEach((shape, index) => indexByWrapper.set(shape, index));

  const indices: number[] = [];
  for (const shape of expanded) {
    const index = indexByWrapper.get(shape);
    if (index !== undefined) {
      indices.push(index);
    }
  }

  return { ok: true, members: toPickRefs(ref, indices) };
}

/**
 * Expand a picked edge (or face) to its whole classified bucket — the
 * double-click gesture ("the whole top rim") — across every rendered solid
 * that carries members of it.
 */
export function expandBucket(scene: SelectionScene, ref: PickRef): ExpandBucketResult {
  const index = new SelectionIndex(scene);
  try {
    const attr = attributePick(scene, index, ref);
    if (attr.error) {
      return { ok: false, reason: attr.error };
    }
    if (!attr.producer) {
      return { ok: false, reason: 'this pick has no classified bucket to expand to' };
    }

    const members = bucketMembers(buildPickUniverse(scene, index, ref.sub.type), attr.producer.bucket);
    if (members.length === 0) {
      return { ok: false, reason: 'no bucket member survives on the current solids' };
    }

    return {
      ok: true,
      members,
      featureType: attr.producer.bucket.feature.getType(),
      accessor: attr.producer.bucket.def.accessor,
    };
  } finally {
    index.dispose();
  }
}
