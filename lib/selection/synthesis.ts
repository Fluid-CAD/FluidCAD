import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Scene } from "../rendering/scene.js";
import { ShapeFilter } from "../filters/filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { injectBelongsToFaceScope } from "../filters/scope-injection.js";
import { SelectionIndex, BucketRecord } from "./selection-index.js";
import { PickAttribution } from "./attribution.js";
import { PickRef } from "./types.js";
import { Atom, instantiateEdgeAtoms, instantiateFaceAtoms } from "./atoms.js";
import { induceConjunction } from "./induction.js";
import { probeEdge, probeFace } from "./probe.js";

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

export type SelectorSynthesis =
  | {
    ok: true;
    producers: SceneObject[];
    /** Statement to anchor scope/insertion on when no producer is bound. */
    anchor: SceneObject | null;
    parts: SelectorPart[];
  }
  | { ok: false; reason: string; pick?: PickRef };

/**
 * Selector synthesis over edge and face picks, following the design's tier
 * ladder. Picks whose producer can be bound to a variable go through the
 * bucket tiers: 0 (whole bucket), 1–2 (bucket + induced filter conjunction),
 * 4 (bucket indices). Picks that cannot be bound — repeat/mirror clones,
 * loop/helper call sites, unclassified geometry — go through tier 3: a
 * scene-wide `select()` with an induced filter, which needs no variable.
 * Every candidate is verified by executing the same resolution the emitted
 * code would run, and required to resolve to exactly the picked set.
 */
export function synthesizeSelectors(
  scene: Scene,
  index: SelectionIndex,
  attributions: PickAttribution[],
): SelectorSynthesis {
  for (const attr of attributions) {
    if (attr.error) {
      return { ok: false, reason: attr.error, pick: attr.ref };
    }
  }

  // Route picks: bindable classified picks group by (producer, bucket);
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
  const parts: SelectorPart[] = [];

  for (const [bucket, groupAttrs] of bucketGroups) {
    const result = synthesizeBucketPart(index, bucket, groupAttrs);
    if (result.ok === false) {
      return result;
    }
    if (!producers.includes(bucket.feature)) {
      producers.push(bucket.feature);
    }
    parts.push(result.part);
  }

  for (const kind of ['edge', 'face'] as const) {
    const pool = globalPools[kind];
    if (pool.length === 0) {
      continue;
    }
    const result = synthesizeGlobalPart(scene, index, kind, pool);
    if (result.ok === false) {
      return result;
    }
    parts.push(result.part);
  }

  let anchor: SceneObject | null = null;
  if (producers.length === 0) {
    anchor = findAnchor(attributions);
    if (!anchor) {
      return {
        ok: false,
        reason: 'no source location is available to anchor the edit',
        pick: attributions[0].ref,
      };
    }
  }

  return { ok: true, producers, anchor, parts };
}

/** Returns a failure reason when the producer cannot be bound to a variable, null when it can. */
function checkBindable(index: SelectionIndex, feature: SceneObject): string | null {
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

type PartResult =
  | { ok: true; part: SelectorPart }
  | { ok: false; reason: string; pick: PickRef };

/** Bucket-tier synthesis: tier 0, then induced filter (1–2), then indices (4). */
function synthesizeBucketPart(
  index: SelectionIndex,
  bucket: BucketRecord,
  groupAttrs: PickAttribution[],
): PartResult {
  const pickKeys = new Set(groupAttrs.map(a => a.pickedKey!));
  const feature = bucket.feature;

  const wholeBucket = bucket.memberKeys.length === pickKeys.size
    && bucket.memberKeys.every(k => pickKeys.has(k));
  if (wholeBucket) {
    const part: SelectorPart = {
      producer: feature, accessor: bucket.def.accessor, indices: null, filterArgs: null, tier: 0,
    };
    const resolved = new ShapeFilter(bucket.members).apply();
    if (resolvesExactly(index, resolved, pickKeys)) {
      return { ok: true, part };
    }
    // Whole-bucket resolution disagreeing with the picks means a later op
    // consumed part of the bucket — fall through to the narrower tiers.
  }

  // Tiers 1–2: induce a filter conjunction over the bucket universe.
  // The evaluation mirrors `resolveEdges`/`resolveFaces` exactly (a plain
  // ShapeFilter over the bucket state array), so induction results hold at
  // accessor-resolution time. `belongsToFace` atoms are excluded: bucket
  // accessors never inject the face-lookup scope those predicates need.
  const induced = induceFilterArgs(index, {
    universeKeys: bucket.memberKeys,
    kindFn: bucket.def.kind,
    evaluate: builders => new ShapeFilter(bucket.members, ...builders).apply(),
    instantiate: attrs => bucket.def.kind === 'edge'
      ? instantiateEdgeAtoms(
        attrs.map(a => probeEdge(a.picked as Edge, a.solidShape)),
        bucket.members as Edge[],
        false,
      ) as Atom<FilterBuilderBase<Shape>>[]
      : instantiateFaceAtoms(
        attrs.map(a => probeFace(a.picked as Face)),
        bucket.members as Face[],
      ) as Atom<FilterBuilderBase<Shape>>[],
    orSplit: false,
  }, groupAttrs, pickKeys);
  if (induced) {
    return {
      ok: true,
      part: {
        producer: feature,
        accessor: bucket.def.accessor,
        indices: null,
        filterArgs: induced.filterArgs,
        tier: induced.constants === 0 ? 1 : 2,
      },
    };
  }

  // Tier 4: bucket indices — the floor, always available.
  const indices = groupAttrs.map(a => a.producer!.index).sort((a, b) => a - b);
  const part: SelectorPart = {
    producer: feature, accessor: bucket.def.accessor, indices, filterArgs: null, tier: 4,
  };
  const builders = bucket.def.kind === 'edge'
    ? indices.map(i => new EdgeFilterBuilder().atIndex(i, bucket.members as Edge[]))
    : indices.map(i => new FaceFilterBuilder().atIndex(i, bucket.members as Face[]));
  const resolved = new ShapeFilter(bucket.members, ...builders).apply();
  if (!resolvesExactly(index, resolved, pickKeys)) {
    const call = `${part.accessor}(${indices.join(', ')})`;
    return {
      ok: false,
      reason: `synthesized selector ${call} did not resolve back to the picked ${bucket.def.kind}s — refusing to write it`,
      pick: groupAttrs[0].ref,
    };
  }
  return { ok: true, part };
}

/**
 * Tier 3: a scene-wide `select()` over the same universe the emitted call
 * would see at end-of-scope — every solid's sub-shapes — with select()'s
 * `belongsToFace` scope injection replicated for both atom evaluation and
 * final verification.
 */
function synthesizeGlobalPart(
  scene: Scene,
  index: SelectionIndex,
  kind: 'edge' | 'face',
  pool: PickAttribution[],
): PartResult {
  if (scene.getAllSceneObjects().some(o => o.getType() === 'part')) {
    return {
      ok: false,
      reason: `the picked ${kind}s need a scene-wide select(), which is not supported in multi-part files yet — select them in code with a geometric filter`,
      pick: pool[0].ref,
    };
  }

  const solids: Solid[] = [];
  const seenSolids = new Set<string>();
  for (const obj of scene.getAllSceneObjects()) {
    for (const shape of obj.getShapes({}, 'solid')) {
      if (shape instanceof Solid && !seenSolids.has(shape.id)) {
        seenSolids.add(shape.id);
        solids.push(shape);
      }
    }
  }

  const universe: Shape[] = [];
  const universeKeys: number[] = [];
  const seenKeys = new Set<number>();
  for (const solid of solids) {
    for (const sub of solid.getSubShapes(kind)) {
      const key = index.keyOf(sub);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        universe.push(sub);
        universeKeys.push(key);
      }
    }
  }

  const pickKeys = new Set(pool.map(a => a.pickedKey!));
  const induced = induceFilterArgs(index, {
    universeKeys,
    kindFn: kind,
    evaluate: builders => {
      const hasher = injectBelongsToFaceScope(builders, () => ({ solids, extraFaces: [] }));
      try {
        return new ShapeFilter(universe, ...builders).apply();
      } finally {
        if (hasher) {
          hasher.delete();
        }
      }
    },
    instantiate: attrs => kind === 'edge'
      ? instantiateEdgeAtoms(
        attrs.map(a => probeEdge(a.picked as Edge, a.solidShape)),
        universe as Edge[],
        true,
      ) as Atom<FilterBuilderBase<Shape>>[]
      : instantiateFaceAtoms(
        attrs.map(a => probeFace(a.picked as Face)),
        universe as Face[],
      ) as Atom<FilterBuilderBase<Shape>>[],
    orSplit: true,
  }, pool, pickKeys);

  if (!induced) {
    return { ok: false, reason: globalFailureReason(kind, pool), pick: pool[0].ref };
  }
  return {
    ok: true,
    part: { producer: null, accessor: 'select', indices: null, filterArgs: induced.filterArgs, tier: 3 },
  };
}

type InductionContext = {
  universeKeys: number[];
  kindFn: 'edge' | 'face';
  /** Runs builders over the universe exactly as the emitted code would. */
  evaluate: (builders: FilterBuilderBase<Shape>[]) => Shape[];
  /** Instantiates candidate atoms from the given picks' geometry. */
  instantiate: (attrs: PickAttribution[]) => Atom<FilterBuilderBase<Shape>>[];
  /** Allow degrading to one filter arg per pick (OR across args). */
  orSplit: boolean;
};

/**
 * Induce filter-builder arguments that resolve to exactly the picked set:
 * one conjunction covering all picks, or (when allowed) one per pick. The
 * returned `filterArgs` is the rendered argument list; a final oracle pass
 * over the composed builders guards against any drift between induction and
 * the code that will be written.
 */
function induceFilterArgs(
  index: SelectionIndex,
  ctx: InductionContext,
  attrs: PickAttribution[],
  pickKeys: Set<number>,
): { filterArgs: string; constants: number } | null {
  const universeSet = new Set(ctx.universeKeys);
  for (const key of pickKeys) {
    if (!universeSet.has(key)) {
      return null;
    }
  }

  const evaluateAtoms = (atoms: Atom<FilterBuilderBase<Shape>>[]) => {
    const matches = new Map<Atom<FilterBuilderBase<Shape>>, Set<number>>();
    for (const atom of atoms) {
      const builder = newBuilder(ctx.kindFn);
      atom.addTo(builder);
      const resolved = ctx.evaluate([builder]);
      matches.set(atom, new Set(resolved.map(s => index.keyOf(s))));
    }
    return matches;
  };

  let conjunctions: Atom<FilterBuilderBase<Shape>>[][] | null = null;

  const atoms = ctx.instantiate(attrs);
  const conjunction = induceConjunction(atoms, evaluateAtoms(atoms), pickKeys, universeSet);
  if (conjunction) {
    conjunctions = [conjunction];
  } else if (ctx.orSplit && attrs.length >= 2 && attrs.length <= 3) {
    conjunctions = [];
    for (const attr of attrs) {
      const single = ctx.instantiate([attr]);
      const singleConjunction = induceConjunction(
        single, evaluateAtoms(single), new Set([attr.pickedKey!]), universeSet,
      );
      if (!singleConjunction) {
        conjunctions = null;
        break;
      }
      conjunctions.push(singleConjunction);
    }
  }
  if (!conjunctions) {
    return null;
  }

  // Final oracle pass over the composed builders, exactly as emitted.
  const builders = conjunctions.map(conj => {
    const builder = newBuilder(ctx.kindFn);
    for (const atom of conj) {
      atom.addTo(builder);
    }
    return builder;
  });
  if (!resolvesExactly(index, ctx.evaluate(builders), pickKeys)) {
    return null;
  }

  const filterArgs = conjunctions
    .map(conj => `${ctx.kindFn}()${conj.map(a => a.code).join('')}`)
    .join(', ');
  const constants = conjunctions.reduce(
    (sum, conj) => sum + conj.reduce((s, a) => s + a.constants, 0), 0,
  );
  return { filterArgs, constants };
}

function newBuilder(kind: 'edge' | 'face'): FilterBuilderBase<Shape> {
  return kind === 'edge'
    ? new EdgeFilterBuilder() as unknown as FilterBuilderBase<Shape>
    : new FaceFilterBuilder() as unknown as FilterBuilderBase<Shape>;
}

function resolvesExactly(index: SelectionIndex, resolved: Shape[], pickKeys: Set<number>): boolean {
  const keys = new Set(resolved.map(s => index.keyOf(s)));
  if (keys.size !== pickKeys.size) {
    return false;
  }
  for (const key of pickKeys) {
    if (!keys.has(key)) {
      return false;
    }
  }
  return true;
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
