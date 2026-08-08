import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { ShapeFilter } from "../filters/filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { SelectionIndex, BucketRecord } from "./selection-index.js";
import { PickAttribution } from "./attribution.js";
import { ParameterLink } from "./atoms.js";
import { PickRef, SelectionScene } from "./types.js";
import {
  bucketContext,
  globalContext,
  induceFilterArgs,
  resolvesExactly,
} from "./filter-search.js";

export type SelectorPart = {
  /** Producer to bind (tiers 0–2, 4), or null for a global `select()` (tier 3). */
  producer: SceneObject | null;
  /** Accessor on the producer's variable, or `select` when producer is null. */
  accessor: string;
  /** Bucket indices (tier 4), or null. */
  indices: number[] | null;
  /** Rendered filter-builder argument list, e.g. `edge().circle(5)` (tiers 1–3). */
  filterArgs: string | null;
  tier: 0 | 1 | 2 | 3 | 4;
};

/** One selector group: the winning form plus verified runner-up forms. */
export type SelectorGroup = {
  winner: SelectorPart;
  alternatives: SelectorPart[];
};

/** A tangent-chain pick: the edge the user right-clicked plus the expansion. */
export type SelectorChain = {
  seed: PickAttribution;
  members: PickAttribution[];
};

export type SelectorSynthesis =
  | {
    ok: true;
    producers: SceneObject[];
    /** Statement to anchor scope/insertion on when no producer is bound. */
    anchor: SceneObject | null;
    groups: SelectorGroup[];
  }
  | { ok: false; reason: string; pick?: PickRef };

/**
 * Selector synthesis over edge and face picks, following the design's tier
 * ladder. Picks whose producer can be bound to a variable go through the
 * bucket tiers: 0 (whole bucket), 1–2 (bucket + induced filter conjunction),
 * 4 (bucket indices). Picks that cannot be bound — repeat/mirror clones,
 * loop/helper call sites, unclassified geometry — go through tier 3: a
 * scene-wide `select()` with an induced filter, which needs no variable.
 * Tangent chains synthesize a seed-isolating filter with `.withTangents()`.
 * Every candidate is verified by executing the same resolution the emitted
 * code would run; each group also keeps its verified runner-up forms so the
 * UI can offer alternatives. `preferBucketIndices` ranks the index form
 * (tier 4) above induced filters within a bucket — plane-only consumers like
 * sketch want the compact `sideFaces(2)` over a filter with baked-in
 * geometry constants; the filter forms stay on as alternatives. Independent
 * of that flag, an induced filter that bakes a geometry constant not linked
 * to a user parameter always ranks below a verified index form (see
 * `synthesizeBucketCandidates`).
 */
export function synthesizeSelectors(
  scene: SelectionScene,
  index: SelectionIndex,
  attributions: PickAttribution[],
  chains: SelectorChain[] = [],
  params: ParameterLink[] = [],
  preferBucketIndices: boolean = false,
): SelectorSynthesis {
  const allAttributions = [
    ...attributions,
    ...chains.flatMap(c => c.members),
  ];
  for (const attr of allAttributions) {
    if (attr.error) {
      return { ok: false, reason: attr.error, pick: attr.ref };
    }
  }

  // Route free picks: bindable classified picks group by (producer, bucket);
  // everything else pools into a per-kind global select() attempt.
  const bucketGroups = new Map<BucketRecord, PickAttribution[]>();
  const globalPools: { edge: PickAttribution[]; face: PickAttribution[] } = { edge: [], face: [] };

  for (const attr of attributions) {
    if (attr.producer && checkBindable(index, attr.producer.bucket.feature) === null) {
      const bucket = attr.producer.bucket;
      let list = bucketGroups.get(bucket);
      if (!list) {
        list = [];
        bucketGroups.set(bucket, list);
      }
      list.push(attr);
    } else {
      globalPools[attr.ref.sub.type].push(attr);
    }
  }

  const producers: SceneObject[] = [];
  const groups: SelectorGroup[] = [];

  const addGroup = (result: GroupResult): { ok: false; reason: string; pick?: PickRef } | null => {
    if (result.ok === false) {
      return result;
    }
    const bound = result.candidates[0].producer;
    if (bound && !producers.includes(bound)) {
      producers.push(bound);
    }
    groups.push({ winner: result.candidates[0], alternatives: result.candidates.slice(1) });
    return null;
  };

  for (const [bucket, groupAttrs] of bucketGroups) {
    const failure = addGroup(
      synthesizeBucketCandidates(index, bucket, groupAttrs, params, preferBucketIndices),
    );
    if (failure) {
      return failure;
    }
  }

  for (const kind of ['edge', 'face'] as const) {
    const pool = globalPools[kind];
    if (pool.length === 0) {
      continue;
    }
    const failure = addGroup(synthesizeGlobalCandidates(scene, index, kind, pool, params));
    if (failure) {
      return failure;
    }
  }

  for (const chain of chains) {
    const failure = addGroup(synthesizeChainCandidates(scene, index, chain, params));
    if (failure) {
      return failure;
    }
  }

  let anchor: SceneObject | null = null;
  if (producers.length === 0) {
    anchor = findAnchor(allAttributions);
    if (!anchor) {
      return {
        ok: false,
        reason: 'no source location is available to anchor the edit',
        pick: allAttributions[0].ref,
      };
    }
  }

  return { ok: true, producers, anchor, groups };
}

/** Returns a failure reason when the producer cannot be bound to a variable, null when it can. */
export function checkBindable(index: SelectionIndex, feature: SceneObject): string | null {
  if (feature.getCloneSource()) {
    return `this selection belongs to a repeated ${feature.getType()}() instance (repeat/mirror)`;
  }
  if (!feature.getSourceLocation()) {
    return `the producing ${feature.getType()}() has no recorded source location`;
  }
  if (index.isSharedCallSite(feature)) {
    return `the ${feature.getType()}() call site produces multiple features (loop or helper)`;
  }
  return null;
}

type GroupResult =
  | { ok: true; candidates: SelectorPart[] }
  | { ok: false; reason: string; pick: PickRef };

/**
 * Bucket-tier candidates, ranked: tier 0 (whole bucket), tiers 1–2 (induced
 * filter), tier 4 (indices) — except when the induced filter carries an
 * unlinked geometry constant, where the verified index form ranks above it.
 * Bucket accessors never inject `belongsToFace` scope, so those atoms are
 * excluded here; the evaluation mirrors `resolveEdges`/`resolveFaces`
 * exactly.
 */
function synthesizeBucketCandidates(
  index: SelectionIndex,
  bucket: BucketRecord,
  groupAttrs: PickAttribution[],
  params: ParameterLink[],
  preferIndices: boolean = false,
): GroupResult {
  const pickKeys = new Set(groupAttrs.map(a => a.pickedKey!));
  const feature = bucket.feature;
  const candidates: SelectorPart[] = [];

  const wholeBucket = bucket.memberKeys.length === pickKeys.size
    && bucket.memberKeys.every(k => pickKeys.has(k));
  if (wholeBucket && resolvesExactly(index, new ShapeFilter(bucket.members).apply(), pickKeys)) {
    candidates.push({
      producer: feature, accessor: bucket.def.accessor, indices: null, filterArgs: null, tier: 0,
    });
  }

  let bakedConstants = 0;
  if (!wholeBucket) {
    const induced = induceFilterArgs(index, bucketContext(bucket, false, params), groupAttrs, pickKeys);
    if (induced) {
      bakedConstants = induced.bakedConstants;
      candidates.push({
        producer: feature,
        accessor: bucket.def.accessor,
        indices: null,
        filterArgs: induced.filterArgs,
        tier: induced.constants === 0 ? 1 : 2,
      });
    }
  }

  const indices = groupAttrs.map(a => a.producer!.index).sort((a, b) => a - b);
  const builders = bucket.def.kind === 'edge'
    ? indices.map(i => new EdgeFilterBuilder().atIndex(i, bucket.members as Edge[]))
    : indices.map(i => new FaceFilterBuilder().atIndex(i, bucket.members as Face[]));
  if (resolvesExactly(index, new ShapeFilter(bucket.members, ...builders).apply(), pickKeys)) {
    candidates.push({
      producer: feature, accessor: bucket.def.accessor, indices, filterArgs: null, tier: 4,
    });
  }

  if (candidates.length === 0) {
    const call = `${bucket.def.accessor}(${indices.join(', ')})`;
    return {
      ok: false,
      reason: `synthesized selector ${call} did not resolve back to the picked ${bucket.def.kind}s — refusing to write it`,
      pick: groupAttrs[0].ref,
    };
  }
  // A filter that only resolves by baking a geometry constant — a measured
  // length like `line(63.30447167189937)` or a positional offset like
  // `onPlane('yz', 233.74)` that no user parameter tracks — silently breaks
  // on dimension edits. The index form survives those, so it outranks the
  // filter; constant-free and parameter-linked filters keep winning.
  if (preferIndices || bakedConstants > 0) {
    // Whole bucket stays first, then indices, then filters (stable sort).
    const rank = (c: SelectorPart) => (c.tier === 0 ? 0 : c.tier === 4 ? 1 : 2);
    candidates.sort((a, b) => rank(a) - rank(b));
  }
  return { ok: true, candidates };
}

/**
 * Tier 3: a scene-wide `select()` over the same universe the emitted call
 * would see at end-of-scope — every solid's sub-shapes — with select()'s
 * `belongsToFace` scope injection replicated for both atom evaluation and
 * final verification.
 */
function synthesizeGlobalCandidates(
  scene: SelectionScene,
  index: SelectionIndex,
  kind: 'edge' | 'face',
  pool: PickAttribution[],
  params: ParameterLink[],
): GroupResult {
  const scope = resolvePartScope(scene, pool);
  if (scope.ok === false) {
    return scope;
  }

  const pickKeys = new Set(pool.map(a => a.pickedKey!));
  const induced = induceFilterArgs(
    index, globalContext(scene, index, kind, params, scope.part), pool, pickKeys,
  );
  if (!induced) {
    return { ok: false, reason: globalFailureReason(kind, pool), pick: pool[0].ref };
  }
  return {
    ok: true,
    candidates: [
      { producer: null, accessor: 'select', indices: null, filterArgs: induced.filterArgs, tier: 3 },
    ],
  };
}

/**
 * Tangent-chain candidates. When every member classifies into one bindable
 * bucket: tier 0 if the chain covers it exactly, then a seed-isolating filter
 * with `.withTangents()` (the runtime `ShapeFilter` expands tangency over the
 * same bucket array), then a plain member conjunction, then indices.
 * Otherwise the same ladder runs over the scene-wide `select()` universe.
 * Every `.withTangents()` candidate is verified by running the real filter —
 * expansion included — and requiring it to resolve to exactly the chain.
 */
function synthesizeChainCandidates(
  scene: SelectionScene,
  index: SelectionIndex,
  chain: SelectorChain,
  params: ParameterLink[],
): GroupResult {
  const kind = chain.seed.ref.sub.type;
  const members = chain.members;
  const memberKeys = new Set(members.map(a => a.pickedKey!));
  const seedKeys = new Set([chain.seed.pickedKey!]);

  const buckets = members.map(a => a.producer ? a.producer.bucket : null);
  const bucket = buckets[0];
  const sameBindableBucket = bucket !== null
    && buckets.every(b => b === bucket)
    && checkBindable(index, bucket.feature) === null;

  if (sameBindableBucket) {
    const candidates: SelectorPart[] = [];
    const feature = bucket.feature;

    const wholeBucket = bucket.memberKeys.length === memberKeys.size
      && bucket.memberKeys.every(k => memberKeys.has(k));
    if (wholeBucket && resolvesExactly(index, new ShapeFilter(bucket.members).apply(), memberKeys)) {
      candidates.push({
        producer: feature, accessor: bucket.def.accessor, indices: null, filterArgs: null, tier: 0,
      });
    }

    const ctx = bucketContext(bucket, false, params);
    const seedInduced = induceFilterArgs(index, ctx, [chain.seed], seedKeys);
    if (seedInduced) {
      for (const builder of seedInduced.builders) {
        builder.withTangents();
      }
      if (resolvesExactly(index, ctx.evaluate(seedInduced.builders), memberKeys)) {
        candidates.push({
          producer: feature,
          accessor: bucket.def.accessor,
          indices: null,
          filterArgs: `${seedInduced.filterArgs}.withTangents()`,
          tier: seedInduced.constants === 0 ? 1 : 2,
        });
      }
    }

    if (!wholeBucket) {
      const plain = induceFilterArgs(index, ctx, members, memberKeys);
      if (plain) {
        candidates.push({
          producer: feature,
          accessor: bucket.def.accessor,
          indices: null,
          filterArgs: plain.filterArgs,
          tier: plain.constants === 0 ? 1 : 2,
        });
      }
    }

    const indices = members.map(a => a.producer!.index).sort((a, b) => a - b);
    const builders = bucket.def.kind === 'edge'
      ? indices.map(i => new EdgeFilterBuilder().atIndex(i, bucket.members as Edge[]))
      : indices.map(i => new FaceFilterBuilder().atIndex(i, bucket.members as Face[]));
    if (resolvesExactly(index, new ShapeFilter(bucket.members, ...builders).apply(), memberKeys)) {
      candidates.push({
        producer: feature, accessor: bucket.def.accessor, indices, filterArgs: null, tier: 4,
      });
    }

    if (candidates.length > 0) {
      return { ok: true, candidates };
    }
    // The chain crosses what the bucket can express — fall through to the
    // scene-wide universe.
  }

  const scope = resolvePartScope(scene, [chain.seed]);
  if (scope.ok === false) {
    return scope;
  }

  const globalCtx = globalContext(scene, index, kind, params, scope.part);
  const candidates: SelectorPart[] = [];

  const seedInduced = induceFilterArgs(index, globalCtx, [chain.seed], seedKeys);
  if (seedInduced) {
    for (const builder of seedInduced.builders) {
      builder.withTangents();
    }
    if (resolvesExactly(index, globalCtx.evaluate(seedInduced.builders), memberKeys)) {
      candidates.push({
        producer: null,
        accessor: 'select',
        indices: null,
        filterArgs: `${seedInduced.filterArgs}.withTangents()`,
        tier: 3,
      });
    }
  }

  const plain = induceFilterArgs(index, globalCtx, members, memberKeys);
  if (plain) {
    candidates.push({
      producer: null, accessor: 'select', indices: null, filterArgs: plain.filterArgs, tier: 3,
    });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no geometric filter isolates the tangent chain's seed ${kind} — `
        + `select the chain in code with a geometric filter and .withTangents()`,
      pick: chain.seed.ref,
    };
  }
  return { ok: true, candidates };
}

/**
 * The part() scope a select()-based edit will execute in: the container all
 * picked solids live in (null = unparted, which sees the whole scene). One
 * statement executes in one scope, so picks spanning different parts are
 * refused rather than emitting a select() that cannot reach half of them.
 */
function resolvePartScope(
  scene: SelectionScene,
  pool: PickAttribution[],
): { ok: true; part: SceneObject | null } | { ok: false; reason: string; pick: PickRef } {
  const parts = new Set(pool.map(a => scene.findEnclosingPart(a.solidOwner!)));
  if (parts.size > 1) {
    return {
      ok: false,
      reason: 'the picked entities live in different part() scopes — one statement cannot select across parts; apply the feature per part',
      pick: pool[0].ref,
    };
  }
  return { ok: true, part: parts.values().next().value ?? null };
}

/** Honest failure message for picks even a scene-wide filter can't separate. */
function globalFailureReason(kind: 'edge' | 'face', pool: PickAttribution[]): string {
  const attr = pool[0];
  const producer = attr.producer ? attr.producer.bucket.feature : null;
  if (producer && producer.getCloneSource()) {
    return `this ${kind} belongs to a repeated ${producer.getType()}() instance and no geometric filter `
      + `distinguishes it from its twins — select it in code directly`;
  }
  if (producer) {
    return `the ${producer.getType()}() call site produces multiple features (loop or helper) and no `
      + `geometric filter distinguishes the picked ${kind}s — select them in code directly`;
  }
  if (attr.lineage && attr.lineage.classified) {
    const origin = attr.lineage.classified.bucket.feature.getType();
    const mods = [...new Set(attr.lineage.modifiedBy.map(m => m.getType()))].join(', ');
    return `this ${kind} originates from ${origin}() but was reshaped by ${mods} afterwards, and no `
      + `geometric filter distinguishes it — select it in code with a geometric filter`;
  }
  return `no geometric filter distinguishes the picked ${kind}s from the rest of the model — `
    + `select them in code instead`;
}

/**
 * A statement to anchor scope and insertion on when no producer is bound:
 * the first pick-related feature that recorded a source location.
 */
function findAnchor(attributions: PickAttribution[]): SceneObject | null {
  for (const attr of attributions) {
    const feature = attr.producer ? attr.producer.bucket.feature : null;
    const candidates = [
      feature,
      feature ? feature.getCloneSource() : null,
      attr.solidOwner,
      attr.solidOwner ? attr.solidOwner.getCloneSource() : null,
    ];
    for (const candidate of candidates) {
      if (candidate && candidate.getSourceLocation()) {
        return candidate;
      }
    }
  }
  return null;
}
