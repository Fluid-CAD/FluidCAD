import { SceneObject } from "../common/scene-object.js";
import { RepeatBase } from "../features/repeat-base.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Plane } from "../math/plane.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeFilter } from "../filters/filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { SelectionIndex, BucketRecord } from "./selection-index.js";
import { PickAttribution } from "./attribution.js";
import { ParameterLink, FaceSource } from "./atoms.js";
import { PickRef, SelectionScene } from "./types.js";
import {
  bucketContext,
  globalContext,
  induceFilterArgs,
  induceFilterCandidates,
  resolvesExactly,
} from "./filter-search.js";
import { mmTol } from "../units/tolerance.js";

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
  /** Geometry constants the filter bakes that no user parameter tracks (filter forms). */
  bakedConstants?: number;
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
    if (attr.producer && canBindProducer(index, attr.producer.bucket.feature, stmtBindable)) {
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

  const faceSources = collectFaceSources(index, stmtBindable);

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
    const sameKind = () => [...bucketResults.entries()]
      .filter(([bucket]) => bucket.def.kind === kind && !absorbed.has(bucket))
      .map(([bucket, group]) => ({ bucket, attrs: group.attrs }));

    const pool = globalPools[kind];
    if (pool.length > 0) {
      const entries = sameKind();
      const wholeFamilies = [...collectWholeFamilies(entries).values()].flat();
      let result: GroupResult | null = null;
      let merged: FamilyGroup[] = [];

      // A whole repeat family alongside the pool (the rim arcs a pattern of
      // cuts left on the body, plus the cuts' own arcs on every instance):
      // one select() over pool and family describes the pattern, so it
      // leads when it needs no baked constant.
      if (wholeFamilies.length > 0) {
        const attempt = synthesizeGlobalCandidates(
          scene, index, kind, [...pool, ...wholeFamilies.flatMap(e => e.attrs)], params, faceSources,
        );
        if (attempt.ok && (attempt.candidates[0].bakedConstants ?? 0) === 0) {
          result = attempt;
          merged = wholeFamilies;
        }
      }

      let alone: GroupResult | null = null;
      if (!result) {
        alone = synthesizeGlobalCandidates(scene, index, kind, pool, params, faceSources);
        if (alone.ok) {
          result = alone;
        }
      }

      if (!result) {
        // The pool must resolve to exactly its own picks — but a pick that
        // no bucket binds (a clone the repeat cannot address, an edge born
        // in a later boolean) often has geometrically identical twins that
        // did bind, and no filter separates it from them. Retry over the
        // union: first the pool plus the buckets of the unbindable clones'
        // source features, then plus every whole repeat family, then plus
        // every same-kind bucket. On success the merged select() replaces
        // the absorbed bucket groups.
        const sources = new Set(pool.map(a =>
          a.producer ? a.producer.bucket.feature.getCloneSource() : null));
        const cloneFamily = entries.filter(e => sources.has(e.bucket.feature));
        const tried = new Set<string>();
        for (const merge of [cloneFamily, wholeFamilies, entries]) {
          const key = merge.map(e => e.bucket.feature.id + e.bucket.def.key).sort().join(',');
          if (merge.length === 0 || tried.has(key)) {
            continue;
          }
          tried.add(key);
          const mergedPool = [...pool, ...merge.flatMap(e => e.attrs)];
          const retry = synthesizeGlobalCandidates(scene, index, kind, mergedPool, params, faceSources);
          if (retry.ok) {
            result = retry;
            merged = merge;
            break;
          }
        }
      }

      if (!result) {
        return alone && alone.ok === false
          ? alone
          : { ok: false, reason: globalFailureReason(kind, pool), pick: pool[0].ref };
      }
      for (const e of merged) {
        absorbed.add(e.bucket);
      }
      globalResults.push(result);
    }

    // A whole repeat family: bucket groups on one repeat's instances (the
    // original and its clones bind separately — `c.endEdges()`,
    // `r.instance(1).endEdges()`, …) that between them reach every instance.
    // The user selected the pattern, not particular instances, so one
    // scene-wide select() describing the pattern's geometry reads better
    // than a per-instance list — but only when it needs no baked constant;
    // the instance forms survive dimension edits, a gap cut does not. A
    // partial family keeps its instance addresses.
    for (const family of collectWholeFamilies(sameKind()).values()) {
      const familyPool = family.flatMap(e => e.attrs);
      const merged = synthesizeGlobalCandidates(scene, index, kind, familyPool, params, faceSources);
      if (merged.ok && (merged.candidates[0].bakedConstants ?? 0) === 0) {
        for (const e of family) {
          absorbed.add(e.bucket);
        }
        globalResults.push(merged);
      }
    }
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
    const failure = addGroup(synthesizeChainCandidates(scene, index, chain, params, faceSources, stmtBindable));
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

/** Angular half of the coplanar test — unit: dimensionless; the linear half is mmTol(1e-7). */
const PLANE_SOURCE_TOLERANCE = 1e-7;

/**
 * Face groups usable as filter references: every bindable feature's face
 * bucket with its as-built members, plus the members' shared plane when
 * they have one (`onPlane`/`above`/`below` references). The plane is the
 * first member's — exactly what the emitted `onPlane(<var>.<accessor>())`
 * resolves — and requiring the rest coplanar with a same-side normal keeps
 * the reference meaningful under member reordering. Consumption doesn't
 * disqualify a group: a bucket accessor resolves its recorded as-built
 * faces, and a reference only reads them (the same contract sketch-on-face
 * relies on).
 */
function collectFaceSources(
  index: SelectionIndex,
  stmtBindable?: (feature: SceneObject) => boolean,
): FaceSource[] {
  const sources: FaceSource[] = [];
  for (const bucket of index.buckets) {
    if (bucket.def.kind !== 'face' || bucket.members.length === 0
      || checkBindable(index, bucket.feature) !== null
      || !(stmtBindable?.(bucket.feature) ?? true)) {
      continue;
    }
    const members = bucket.members.filter((m): m is Face => m instanceof Face);
    if (members.length !== bucket.members.length) {
      continue;
    }
    const planes: Plane[] = [];
    for (const member of members) {
      const plane = FaceOps.tryGetPlane(member);
      if (!plane) {
        break;
      }
      planes.push(plane);
    }
    let plane: Plane | null = null;
    if (planes.length === members.length) {
      const first = planes[0];
      const shared = planes.every(p =>
        first.isCoplanarWith(p, mmTol(1e-7), PLANE_SOURCE_TOLERANCE)
        && first.normal.dot(p.normal) > 0);
      plane = shared ? first : null;
    }
    const binding = producerBinding(bucket.feature);
    const accessor = `${binding.accessorPrefix}${bucket.def.accessor}`;
    sources.push({
      feature: binding.producer,
      accessor,
      members,
      plane,
      // Evaluate through the very accessor object the emitted code names —
      // the lazy selection resolves the recorded group on demand.
      resolve: () => binding.resolveAccessor(bucket.def.accessor),
    });
  }
  // The index scans latest-first, which puts a repeat's clones ahead of
  // their original. A reference should name the original's group
  // (`e.endFaces()`, not `r.instance(2).endFaces()`) when both describe the
  // same plane, so originals lead; the sort is stable within each half.
  return sources.sort((a, b) => Number(a.accessor.startsWith('instance(')) - Number(b.accessor.startsWith('instance(')));
}

/**
 * How emitted code reaches a producer's accessors: through the feature's
 * own variable, or — for a feature `repeat()` cloned into one of its slots —
 * through the repeat's variable and `instance(k)`, which forwards the clone's
 * bucket accessors. `producer` is what binds a variable; `accessorPrefix`
 * goes between the variable and the bucket accessor; `resolveAccessor`
 * evaluates an accessor exactly as the rendered code would.
 */
export type ProducerBinding = {
  producer: SceneObject;
  accessorPrefix: string;
  resolveAccessor: (accessor: string) => SceneObject;
};

/**
 * The repeat slot `feature` is a root clone of, when its repeat can address
 * it: the clone sits directly under the repeat container, its slot holds
 * exactly one repeated feature (so `instance(k)` forwards unambiguously),
 * and the pick attributes to that feature — not to a dependency clone the
 * repeat pulled in alongside it.
 */
function cloneSlot(feature: SceneObject): { repeat: RepeatBase; slot: number } | null {
  if (!feature.getCloneSource()) {
    return null;
  }
  const parent = feature.getParent();
  if (!(parent instanceof RepeatBase)) {
    return null;
  }
  const slot = parent.slotOf(feature);
  if (slot === null || parent.getInstanceRoots(slot).length !== 1) {
    return null;
  }
  return { repeat: parent, slot };
}

type FamilyGroup = { bucket: BucketRecord; attrs: PickAttribution[] };

/**
 * Bucket groups that together cover a whole repeat: for every repeat some
 * group's clone binds through, the groups on any of its slots (the
 * original's included), kept only when they reach every live slot.
 */
function collectWholeFamilies(groups: FamilyGroup[]): Map<RepeatBase, FamilyGroup[]> {
  const repeats = new Set<RepeatBase>();
  for (const { bucket } of groups) {
    const clone = cloneSlot(bucket.feature);
    if (clone) {
      repeats.add(clone.repeat);
    }
  }
  const families = new Map<RepeatBase, FamilyGroup[]>();
  for (const repeat of repeats) {
    const family = groups.filter(g => repeat.slotOf(g.bucket.feature) !== null);
    const slots = new Set(family.map(g => repeat.slotOf(g.bucket.feature)));
    const live = repeat.getInstanceSlots().filter(slot => slot !== null).length;
    if (slots.size >= 2 && slots.size >= live) {
      families.set(repeat, family);
    }
  }
  return families;
}

export function producerBinding(feature: SceneObject): ProducerBinding {
  const clone = cloneSlot(feature);
  if (!clone) {
    return {
      producer: feature,
      accessorPrefix: '',
      resolveAccessor: accessor => callAccessor(feature, accessor),
    };
  }
  return {
    producer: clone.repeat,
    accessorPrefix: `instance(${clone.slot}).`,
    resolveAccessor: accessor => callAccessor(clone.repeat.instance(clone.slot), accessor),
  };
}

function callAccessor(target: object, accessor: string): SceneObject {
  return (target as unknown as Record<string, () => SceneObject>)[accessor]();
}

/**
 * Whether the emitted code can reference `feature` through a bound variable:
 * bindable structurally ({@link checkBindable}) and accepted by the
 * statement-level probe the server resolves from the live buffer. The one
 * rule every producer-binding route — bucket routing and the plane/surface
 * stand-in searches — decides by.
 */
export function canBindProducer(
  index: SelectionIndex,
  feature: SceneObject,
  stmtBindable?: (feature: SceneObject) => boolean,
): boolean {
  return checkBindable(index, feature) === null
    && (stmtBindable?.(producerBinding(feature).producer) ?? true);
}

/**
 * Returns a failure reason when the producer cannot be bound to a variable,
 * null when it can. A repeat clone binds through its repeat's variable
 * (`r.instance(k)`), so it is bindable exactly when the repeat is.
 */
export function checkBindable(index: SelectionIndex, feature: SceneObject): string | null {
  if (feature.getCloneSource()) {
    const clone = cloneSlot(feature);
    if (!clone) {
      return `this selection belongs to a repeated ${feature.getType()}() instance (repeat/mirror) `
        + `that instance(k) cannot address`;
    }
    return checkBindable(index, clone.repeat);
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
  const { producer: feature, accessorPrefix } = producerBinding(bucket.feature);
  const accessor = `${accessorPrefix}${bucket.def.accessor}`;
  const candidates: SelectorPart[] = [];

  const wholeBucket = bucket.memberKeys.length === pickKeys.size
    && bucket.memberKeys.every(k => pickKeys.has(k));
  if (wholeBucket && resolvesExactly(index, new ShapeFilter(bucket.members).apply(), pickKeys)) {
    candidates.push({
      producer: feature, accessor, indices: null, filterArgs: null, tier: 0,
    });
  }

  // Every verified filter form, best first; each remembers whether it bakes
  // a geometry constant so the ranking below can place it against the index.
  const baked = new Map<SelectorPart, number>();
  if (!wholeBucket) {
    for (const induced of induceFilterCandidates(index, bucketContext(bucket, false, params), groupAttrs, pickKeys)) {
      const part: SelectorPart = {
        producer: feature,
        accessor,
        indices: null,
        filterArgs: induced.filterArgs,
        tier: induced.constants === 0 ? 1 : 2,
      };
      baked.set(part, induced.bakedConstants);
      candidates.push(part);
    }
  }

  const indices = groupAttrs.map(a => a.producer!.index).sort((a, b) => a - b);
  const builders = bucket.def.kind === 'edge'
    ? indices.map(i => new EdgeFilterBuilder().atIndex(i, bucket.members as Edge[]))
    : indices.map(i => new FaceFilterBuilder().atIndex(i, bucket.members as Face[]));
  if (resolvesExactly(index, new ShapeFilter(bucket.members, ...builders).apply(), pickKeys)) {
    candidates.push({
      producer: feature, accessor, indices, filterArgs: null, tier: 4,
    });
  }

  if (candidates.length === 0) {
    const call = `${accessor}(${indices.join(', ')})`;
    return {
      ok: false,
      reason: `synthesized selector ${call} did not resolve back to the picked ${bucket.def.kind}s — refusing to write it`,
      pick: groupAttrs[0].ref,
    };
  }
  // A filter that only resolves by baking a geometry constant — a measured
  // length like `line(63.30447167189937)` or a positional offset like
  // `onPlane('yz', 233.74)` that no user parameter tracks — silently breaks
  // on dimension edits. The index form survives those, so it outranks such
  // a filter; constant-free and parameter-linked filters keep winning unless
  // the consumer asked for indices first. Whole bucket always leads; the
  // sort is stable, so induction's own order holds within each rank.
  const rank = (c: SelectorPart) => {
    if (c.tier === 0) {
      return 0;
    }
    if (c.tier === 4) {
      return preferIndices ? 1 : 2;
    }
    if ((baked.get(c) ?? 0) > 0) {
      return 3;
    }
    return preferIndices ? 2 : 1;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
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
  faceSources: FaceSource[],
): GroupResult {
  const scope = resolvePartScope(scene, pool);
  if (scope.ok === false) {
    return scope;
  }

  const pickKeys = new Set(pool.map(a => a.pickedKey!));
  const induced = induceFilterCandidates(
    index, globalContext(scene, index, kind, params, scope.part, faceSources), pool, pickKeys,
  );
  if (induced.length === 0) {
    return { ok: false, reason: globalFailureReason(kind, pool), pick: pool[0].ref };
  }
  return {
    ok: true,
    candidates: induced.map(candidate => ({
      producer: null,
      accessor: 'select',
      indices: null,
      filterArgs: candidate.filterArgs,
      refs: candidate.refs,
      bakedConstants: candidate.bakedConstants,
      tier: 3,
    })),
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
  faceSources: FaceSource[],
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
    && canBindProducer(index, bucket.feature, stmtBindable);

  if (sameBindableBucket) {
    const candidates: SelectorPart[] = [];
    const { producer: feature, accessorPrefix } = producerBinding(bucket.feature);
    const accessor = `${accessorPrefix}${bucket.def.accessor}`;

    const wholeBucket = bucket.memberKeys.length === memberKeys.size
      && bucket.memberKeys.every(k => memberKeys.has(k));
    if (wholeBucket && resolvesExactly(index, new ShapeFilter(bucket.members).apply(), memberKeys)) {
      candidates.push({
        producer: feature, accessor, indices: null, filterArgs: null, tier: 0,
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
          accessor,
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
          accessor,
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
        producer: feature, accessor, indices, filterArgs: null, tier: 4,
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

  const globalCtx = globalContext(scene, index, kind, params, scope.part, faceSources);
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
