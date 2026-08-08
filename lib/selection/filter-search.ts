import { Edge } from "../common/edge.js";
import { SceneObject } from "../common/scene-object.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { SelectionScene } from "./types.js";
import { ShapeFilter } from "../filters/filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { injectBelongsToFaceScope } from "../filters/scope-injection.js";
import { SelectionIndex, BucketRecord } from "./selection-index.js";
import { PickAttribution } from "./attribution.js";
import { Atom, ParameterLink, instantiateEdgeAtoms, instantiateFaceAtoms } from "./atoms.js";
import { induceConjunction } from "./induction.js";
import { probeEdge, probeFace } from "./probe.js";

/**
 * One induction universe: the shapes a candidate filter runs over and the
 * exact evaluation the emitted code would perform there. Bucket contexts
 * mirror `resolveEdges`/`resolveFaces`; the global context mirrors what a
 * `select()` sees at end-of-scope, including its `belongsToFace` scope
 * injection.
 */
export type InductionContext = {
  universeKeys: number[];
  kindFn: 'edge' | 'face';
  /** Runs builders over the universe exactly as the emitted code would. */
  evaluate: (builders: FilterBuilderBase<Shape>[]) => Shape[];
  /** Instantiates candidate atoms from the given picks' geometry. */
  instantiate: (attrs: PickAttribution[]) => Atom<FilterBuilderBase<Shape>>[];
  /** Allow degrading to one filter arg per pick (OR across args). */
  orSplit: boolean;
};

export type InducedFilter = {
  /** Rendered argument list, e.g. `edge().circle(5)` — one entry per builder. */
  filterArgs: string;
  constants: number;
  /** Geometry-valued constants not linked to a user parameter. */
  bakedConstants: number;
  /** The composed builders, exactly as the rendered text would build them. */
  builders: FilterBuilderBase<Shape>[];
};

export function bucketContext(
  bucket: BucketRecord,
  orSplit: boolean,
  params: ParameterLink[] = [],
): InductionContext {
  return {
    universeKeys: bucket.memberKeys,
    kindFn: bucket.def.kind,
    evaluate: builders => new ShapeFilter(bucket.members, ...builders).apply(),
    instantiate: attrs => bucket.def.kind === 'edge'
      ? instantiateEdgeAtoms(
        attrs.map(a => probeEdge(a.picked as Edge, a.solidShape)),
        bucket.members as Edge[],
        false,
        params,
      ) as Atom<FilterBuilderBase<Shape>>[]
      : instantiateFaceAtoms(
        attrs.map(a => probeFace(a.picked as Face)),
        bucket.members as Face[],
        params,
      ) as Atom<FilterBuilderBase<Shape>>[],
    orSplit,
  };
}

export function globalContext(
  scene: SelectionScene,
  index: SelectionIndex,
  kind: 'edge' | 'face',
  params: ParameterLink[] = [],
  partScope: SceneObject | null = null,
): InductionContext {
  const solids: Solid[] = [];
  const seenSolids = new Set<string>();
  const objects = scene.getAllSceneObjects();
  // Removal scope: a solid only counts as consumed when its consumer is in
  // this scene's object list. Under an edit boundary the scene is truncated,
  // and a solid eaten by the edited statement (or anything after it) is still
  // present in the world the emitted select() executes in — the same scope
  // rule renderRollback applies.
  const scope = new Set(objects);
  for (const obj of objects) {
    // A select() statement inserted inside a part() body only sees that
    // part's objects (getPartScopedObjectsUpTo); mirror it here so
    // verification runs over the same universe the emitted code will.
    if (partScope && scene.findEnclosingPart(obj) !== partScope) {
      continue;
    }
    for (const shape of obj.getShapes({}, 'solid', scope)) {
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

  return {
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
        params,
      ) as Atom<FilterBuilderBase<Shape>>[]
      : instantiateFaceAtoms(
        attrs.map(a => probeFace(a.picked as Face)),
        universe as Face[],
        params,
      ) as Atom<FilterBuilderBase<Shape>>[],
    orSplit: true,
  };
}

/**
 * Induce filter-builder arguments that resolve to exactly the picked set:
 * one conjunction covering all picks, or (when allowed) one per pick. The
 * returned `filterArgs` is the rendered argument list; a final oracle pass
 * over the composed builders guards against any drift between induction and
 * the code that will be written.
 */
export function induceFilterArgs(
  index: SelectionIndex,
  ctx: InductionContext,
  attrs: PickAttribution[],
  pickKeys: Set<number>,
): InducedFilter | null {
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
  const bakedConstants = conjunctions.reduce(
    (sum, conj) => sum + conj.reduce((s, a) => s + (a.bakedConstants ?? 0), 0), 0,
  );
  return { filterArgs, constants, bakedConstants, builders };
}

export function newBuilder(kind: 'edge' | 'face'): FilterBuilderBase<Shape> {
  return kind === 'edge'
    ? new EdgeFilterBuilder() as unknown as FilterBuilderBase<Shape>
    : new FaceFilterBuilder() as unknown as FilterBuilderBase<Shape>;
}

export function resolvesExactly(index: SelectionIndex, resolved: Shape[], pickKeys: Set<number>): boolean {
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
