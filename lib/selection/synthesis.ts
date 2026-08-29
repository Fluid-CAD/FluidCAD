import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Plane } from "../math/plane.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeFilter } from "../filters/filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { SelectionIndex, BucketRecord } from "./selection-index.js";
import { PickAttribution } from "./attribution.js";
import { ParameterLink, PlaneSource } from "./atoms.js";
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
  /**
   * Producers `filterArgs` references through `{{r<n>}}` tokens
   * (plane-reference atoms); each needs a bound variable at render time.
   */
  refs?: SceneObject[];
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
  stmtBindable?: (feature: SceneObject) => boolean,
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

  // One statement executes in one part() scope. The global-select and chain
  // paths refuse multi-part pools individually below, but bucket-tier picks
  // (and mixes of routes) used to sail through synthesis and only fail at
  // apply time, deep in the transform — after the preview had rendered a
  // plausible expression. Refuse up front, over every pick synthesis routes.
  const scopePool = [...attributions, ...chains.flatMap(c => [c.seed, ...c.members])];
  let scopePart: SceneObject | null | undefined;
  for (const attr of scopePool) {
    if (!attr.solidOwner) {
      continue;
    }
    const enclosing = scene.findEnclosingPart(attr.solidOwner);
    if (scopePart === undefined) {
      scopePart = enclosing;
    } else if (enclosing !== scopePart) {
      return {
        ok: false,
        reason: 'the picked entities live in different part() scopes — one statement cannot select across parts; apply the feature per part',
        pick: attr.ref,
      };
    }
  }

  // Route free picks: bindable classified picks group by (producer, bucket);
  // everything else pools into a per-kind global select() attempt.
  const bucketGroups = new Map<BucketRecord, PickAttribution[]>();
  const globalPools: { edge: PickAttribution[]; face: PickAttribution[] } = { edge: [], face: [] };

  for (const attr of attributions) {
    if (attr.producer && checkBindable(index, attr.producer.bucket.feature) === null
      && (stmtBindable?.(attr.producer.bucket.feature) ?? true)) {
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
    const winner = result.candidates[0];
    const bound = winner.producer;
    if (bound && !producers.includes(bound)) {
      producers.push(bound);
    }
    // Referenced producers (plane-reference tokens) bind a variable exactly
    // like bucket producers — only the winner's; an alternative-only
    // reference must not cost the emitted code an unused binding.
    for (const ref of winner.refs ?? []) {
      if (!producers.includes(ref)) {
        producers.push(ref);
      }
    }
    groups.push({ winner, alternatives: result.candidates.slice(1) });
    return null;
  };

  const planeSources = collectPlaneSources(index, stmtBindable);

  // Bucket groups synthesize first but commit last: a global pool that can't
  // resolve on its own may need to absorb same-kind bucket picks (see below),
  // and an absorbed group must not have bound its producer already.
  const bucketResults = new Map<BucketRecord, { attrs: PickAttribution[]; result: GroupResult }>();
  for (const [bucket, groupAttrs] of bucketGroups) {
    bucketResults.set(bucket, {
      attrs: groupAttrs,
      result: synthesizeBucketCandidates(index, bucket, groupAttrs, params, preferBucketIndices),
    });
  }

  const globalResults: GroupResult[] = [];
  const absorbed = new Set<BucketRecord>();
  for (const kind of ['edge', 'face'] as const) {
    const pool = globalPools[kind];
    if (pool.length === 0) {
      continue;
    }
    let result = synthesizeGlobalCandidates(scene, index, kind, pool, params, planeSources);
    if (result.ok === false) {
      // The pool must resolve to exactly its own picks — but when the user
      // selected a whole repeat family (original + clones), the original's
      // picks were routed to its bindable bucket, and no filter separates the
      // clones from that geometrically identical twin. Retry over the union:
      // first the pool plus the same-kind buckets of the clones' source
      // features, then plus every same-kind bucket. On success the merged
      // select() replaces the absorbed bucket groups.
      const sameKind = [...bucketResults.entries()]
        .filter(([bucket]) => bucket.def.kind === kind);
      const sources = new Set(pool.map(a =>
        a.producer ? a.producer.bucket.feature.getCloneSource() : null));
      const family = sameKind.filter(([bucket]) => sources.has(bucket.feature));
      for (const merge of family.length > 0 && family.length < sameKind.length
        ? [family, sameKind] : [sameKind]) {
        if (merge.length === 0) {
          break;
        }
        const mergedPool = [...pool, ...merge.flatMap(([, group]) => group.attrs)];
        const retry = synthesizeGlobalCandidates(scene, index, kind, mergedPool, params, planeSources);
        if (retry.ok) {
          result = retry;
          for (const [bucket] of merge) {
            absorbed.add(bucket);
          }
          break;
        }
      }
    }
    if (result.ok === false) {
      return result;
    }
    globalResults.push(result);
  }

  for (const [bucket, { result }] of bucketResults) {
    if (absorbed.has(bucket)) {
      continue;
    }
    const failure = addGroup(result);
    if (failure) {
      return failure;
    }
  }

  for (const result of globalResults) {
    const failure = addGroup(result);
    if (failure) {
      return failure;
    }
  }

  for (const chain of chains) {
    const failure = addGroup(synthesizeChainCandidates(scene, index, chain, params, planeSources, stmtBindable));
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

const PLANE_SOURCE_TOLERANCE = 1e-7;

/**
 * Face groups usable as plane references (`onPlane(e.endFaces())`): every
 * bindable feature's face bucket whose members share one plane. The plane is
 * the first member's — exactly what the emitted `onPlane(<var>.<accessor>())`
 * resolves — and requiring the rest coplanar with a same-side normal keeps
 * the reference meaningful under member reordering. Consumption doesn't
 * disqualify a group: a bucket accessor resolves its recorded as-built
 * faces, and a plane reference only reads the plane off them (the same
 * contract sketch-on-face relies on).
 */
function collectPlaneSources(
  index: SelectionIndex,
  stmtBindable?: (feature: SceneObject) => boolean,
): PlaneSource[] {
  const sources: PlaneSource[] = [];
  for (const bucket of index.buckets) {
    if (bucket.def.kind !== 'face' || checkBindable(index, bucket.feature) !== null
      || !(stmtBindable?.(bucket.feature) ?? true)) {
      continue;
    }
    const planes: Plane[] = [];
    for (const member of bucket.members) {
      const plane = member instanceof Face ? FaceOps.tryGetPlane(member) : null;
      if (!plane) {
        break;
      }
      planes.push(plane);
    }
    if (planes.length !== bucket.members.length) {
      continue;
    }
    const first = planes[0];
    const shared = planes.every(p =>
      first.isCoplanarWith(p, PLANE_SOURCE_TOLERANCE, PLANE_SOURCE_TOLERANCE)
      && first.normal.dot(p.normal) > 0);
    if (shared) {
      sources.push({ feature: bucket.feature, accessor: bucket.def.accessor, plane: first });
    }
  }
  return sources;
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
  planeSources: PlaneSource[],
): GroupResult {
  const scope = resolvePartScope(scene, pool);
  if (scope.ok === false) {
    return scope;
  }

  const pickKeys = new Set(pool.map(a => a.pickedKey!));
  const induced = induceFilterArgs(
    index, globalContext(scene, index, kind, params, scope.part, planeSources), pool, pickKeys,
  );
  if (!induced) {
    return { ok: false, reason: globalFailureReason(kind, pool), pick: pool[0].ref };
  }
  return {
    ok: true,
    candidates: [
      {
        producer: null,
        accessor: 'select',
        indices: null,
        filterArgs: induced.filterArgs,
        refs: induced.refs,
        tier: 3,
      },
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
  planeSources: PlaneSource[],
  stmtBindable?: (feature: SceneObject) => boolean,
): GroupResult {
  const kind = chain.seed.ref.sub.type;
  const members = chain.members;
  const memberKeys = new Set(members.map(a => a.pickedKey!));
  const seedKeys = new Set([chain.seed.pickedKey!]);

  const buckets = members.map(a => a.producer ? a.producer.bucket : null);
  const bucket = buckets[0];
  const sameBindableBucket = bucket !== null
    && buckets.every(b => b === bucket)
    && checkBindable(index, bucket.feature) === null
    && (stmtBindable?.(bucket.feature) ?? true);

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

  const globalCtx = globalContext(scene, index, kind, params, scope.part, planeSources);
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
        refs: seedInduced.refs,
        tier: 3,
      });
    }
  }

  const plain = induceFilterArgs(index, globalCtx, members, memberKeys);
  if (plain) {
    candidates.push({
      producer: null,
      accessor: 'select',
      indices: null,
      filterArgs: plain.filterArgs,
      refs: plain.refs,
      tier: 3,
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
