import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { ShapeFilter } from "../filters/filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { SelectionIndex, BucketRecord } from "./selection-index.js";
import { PickAttribution } from "./attribution.js";
import { PickRef } from "./types.js";

export type SelectorPart = {
  producer: SceneObject;
  accessor: string;
  /** Bucket indices, or null for the whole bucket (tier 0). */
  indices: number[] | null;
  tier: 0 | 4;
};

export type SelectorSynthesis =
  | { ok: true; producers: SceneObject[]; parts: SelectorPart[] }
  | { ok: false; reason: string; pick?: PickRef };

/**
 * Phase-1 selector synthesis over edge picks: tier 0 (whole bucket) when the
 * user's selection covers a bucket exactly, tier 4 (bucket indices) otherwise.
 * Every emitted part is verified by executing the same resolution the
 * accessors run (`ShapeFilter` over the bucket state array), so a candidate
 * that would resolve to anything other than the picked set is rejected here
 * rather than producing wrong code.
 */
export function synthesizeEdgeSelectors(
  index: SelectionIndex,
  attributions: PickAttribution[],
): SelectorSynthesis {
  for (const attr of attributions) {
    if (attr.error) {
      return { ok: false, reason: attr.error, pick: attr.ref };
    }
    if (attr.ref.sub.type !== 'edge') {
      return { ok: false, reason: 'only edges can be selected for this feature', pick: attr.ref };
    }
    if (!attr.producer) {
      return { ok: false, reason: unattributableReason(attr), pick: attr.ref };
    }
  }

  // Group picks by (producer feature, bucket) in first-pick order.
  const groups = new Map<BucketRecord, PickAttribution[]>();
  for (const attr of attributions) {
    const bucket = attr.producer!.bucket;
    let list = groups.get(bucket);
    if (!list) {
      list = [];
      groups.set(bucket, list);
    }
    list.push(attr);
  }

  const producers: SceneObject[] = [];
  const parts: SelectorPart[] = [];

  for (const [bucket, groupAttrs] of groups) {
    const feature = bucket.feature;
    const bindable = checkBindable(index, feature);
    if (bindable) {
      return { ok: false, reason: bindable, pick: groupAttrs[0].ref };
    }
    if (!producers.includes(feature)) {
      producers.push(feature);
    }

    const pickKeys = new Set(groupAttrs.map(a => a.pickedKey!));
    const wholeBucket = bucket.memberKeys.length === pickKeys.size
      && bucket.memberKeys.every(k => pickKeys.has(k));

    const indices = groupAttrs
      .map(a => a.producer!.index)
      .sort((a, b) => a - b);

    const part: SelectorPart = wholeBucket
      ? { producer: feature, accessor: bucket.def.accessor, indices: null, tier: 0 }
      : { producer: feature, accessor: bucket.def.accessor, indices, tier: 4 };

    const verification = verifyPart(index, bucket, part, pickKeys);
    if (verification) {
      return { ok: false, reason: verification, pick: groupAttrs[0].ref };
    }
    parts.push(part);
  }

  return { ok: true, producers, parts };
}

function unattributableReason(attr: PickAttribution): string {
  const lineage = attr.lineage;
  if (lineage && lineage.classified) {
    const origin = lineage.classified.bucket.feature.getType();
    const mods = [...new Set(lineage.modifiedBy.map(m => m.getType()))].join(', ');
    return `this edge originates from ${origin}() but was reshaped by ${mods} afterwards — `
      + `it can't be expressed as a bucket selection yet`;
  }
  return 'this edge is not classified by any feature — select it in code with a geometric filter';
}

/** Returns a failure reason when the producer cannot be bound to a variable, null when it can. */
function checkBindable(index: SelectionIndex, feature: SceneObject): string | null {
  if (feature.getCloneSource()) {
    return `this edge belongs to a repeated ${feature.getType()}() instance (repeat/mirror) — `
      + `select it in code with a geometric filter`;
  }
  if (!feature.getSourceLocation()) {
    return `the producing ${feature.getType()}() has no recorded source location`;
  }
  if (index.isSharedCallSite(feature)) {
    return `the ${feature.getType()}() call site produces multiple features (loop or helper) — `
      + `select this edge in code with a geometric filter`;
  }
  return null;
}

/**
 * Oracle verification: resolve the candidate through the real filter engine —
 * the same `ShapeFilter` + `atIndex` path the accessors run over the same
 * state array — and require IsSame-set equality with the picked edges.
 * Returns a failure reason, or null when the candidate verifies.
 */
function verifyPart(
  index: SelectionIndex,
  bucket: BucketRecord,
  part: SelectorPart,
  pickKeys: Set<number>,
): string | null {
  const members = bucket.members as Edge[];
  let resolved: Edge[];
  if (part.indices === null) {
    resolved = new ShapeFilter(members).apply() as Edge[];
  } else {
    const filters = part.indices.map(i => new EdgeFilterBuilder().atIndex(i, members));
    resolved = new ShapeFilter(members, ...filters).apply() as Edge[];
  }

  const resolvedKeys = new Set(resolved.map(e => index.keyOf(e)));
  if (resolvedKeys.size !== pickKeys.size) {
    return verificationFailure(part);
  }
  for (const key of pickKeys) {
    if (!resolvedKeys.has(key)) {
      return verificationFailure(part);
    }
  }
  return null;
}

function verificationFailure(part: SelectorPart): string {
  const call = `${part.accessor}(${part.indices?.join(', ') ?? ''})`;
  return `synthesized selector ${call} did not resolve back to the picked edges — refusing to write it`;
}
