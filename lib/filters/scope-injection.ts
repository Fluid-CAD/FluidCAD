import { Face } from "../common/face.js";
import { Solid } from "../common/solid.js";
import { Shape } from "../common/shape.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { FilterBase } from "./filter-base.js";
import { FilterBuilderBase } from "./filter-builder-base.js";

export type FilterScope = {
  solids: Solid[];
  /** Faces in scope that are not part of a solid (no cached topology index). */
  extraFaces: Face[];
};

/**
 * A filter that needs to look beyond the shape it tests — an edge's owning
 * faces (`belongsToFace`, `convex`/`concave`/`smooth`) — receives the solids
 * in scope plus a shared `IsSame`-consistent face index through this hook.
 */
export interface ScopeAwareFilter {
  setScopeIndex(solids: Solid[], extraFaces: Face[], faceByHash: Map<number, Face[]>, hasher: ShapeHasher): void;
}

export function isScopeAware(filter: FilterBase<Shape>): filter is FilterBase<Shape> & ScopeAwareFilter {
  return typeof (filter as Partial<ScopeAwareFilter>).setScopeIndex === 'function';
}

/**
 * Give every scope-aware predicate in the builders its lookup scope. Without
 * this injection such a predicate sees an empty scope and matches nothing —
 * `select()` runs it before applying filters, bucket accessors run it over the
 * feature's own as-built solid, and any other evaluator of builders containing
 * scope-aware filters must run it too.
 *
 * The scope is resolved lazily on the first scope-aware filter encountered.
 * Returns the hasher backing the shared face index (owner must `delete()` it
 * after applying the filters), or null when no filter needed injection.
 */
export function injectFilterScope(
  filters: FilterBuilderBase<Shape>[],
  resolveScope: () => FilterScope,
): ShapeHasher | null {
  let scopeSolids: Solid[] | null = null;
  let extraFaces: Face[] | null = null;
  let faceByHash: Map<number, Face[]> | null = null;
  let hasher: ShapeHasher | null = null;

  for (const builder of filters) {
    for (const filter of builder.getFilters()) {
      if (!isScopeAware(filter)) {
        continue;
      }
      if (!scopeSolids) {
        const scope = resolveScope();
        scopeSolids = scope.solids;
        extraFaces = scope.extraFaces;

        faceByHash = new Map<number, Face[]>();
        hasher = new ShapeHasher();
        for (const solid of scopeSolids) {
          for (const face of solid.getFaces()) {
            addToBucket(faceByHash, face, hasher);
          }
        }
        for (const face of extraFaces) {
          addToBucket(faceByHash, face, hasher);
        }
      }
      filter.setScopeIndex(scopeSolids, extraFaces!, faceByHash!, hasher!);
    }
  }

  return hasher;
}

/** True when any builder carries a filter that needs scope injection. */
export function needsFilterScope(filters: FilterBuilderBase<Shape>[]): boolean {
  return filters.some(builder => builder.getFilters().some(isScopeAware));
}

function addToBucket(faceByHash: Map<number, Face[]>, face: Face, hasher: ShapeHasher) {
  const hash = hasher.key(face.getShape());
  let bucket = faceByHash.get(hash);
  if (!bucket) {
    bucket = [];
    faceByHash.set(hash, bucket);
  }
  bucket.push(face);
}
