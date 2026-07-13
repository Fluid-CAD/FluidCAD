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
 * A bucket's surviving members on the rendered solid, as pick refs. Bucket
 * members are as-built wrappers; the `IsSame`-consistent hash keys bridge
 * them onto the picked solid's mesh-order universe, so members a later
 * boolean consumed are skipped naturally.
 */
export function bucketMembersOnSolid(
  index: SelectionIndex,
  bucket: BucketRecord,
  solid: Shape,
  ref: PickRef,
): PickRef[] {
  const memberKeys = new Set(bucket.memberKeys);
  const universe = pickUniverse(solid, ref.sub.type);
  const indices: number[] = [];
  universe.forEach((shape, universeIndex) => {
    if (memberKeys.has(index.keyOf(shape))) {
      indices.push(universeIndex);
    }
  });
  return toPickRefs(ref, indices);
}

/**
 * Expand a picked edge (or face) to its full tangent chain on the owning
 * solid — the "Select with tangents" gesture. Returns every chain member as
 * a pick ref in mesh exploration order (the seed included), so the UI can
 * highlight them exactly like ordinary picks.
 */
export function expandTangentChain(scene: SelectionScene, ref: PickRef): ExpandTangentsResult {
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
 * double-click gesture ("the whole top rim").
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

    const members = bucketMembersOnSolid(index, attr.producer.bucket, attr.solidShape!, ref);
    if (members.length === 0) {
      return { ok: false, reason: 'no bucket member survives on the current solid' };
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
