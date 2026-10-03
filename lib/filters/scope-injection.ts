import { Face } from "../common/face.js";
import { Solid } from "../common/solid.js";
import { Shape } from "../common/shape.js";
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
 * in scope (each answers edge→faces from its own cached index) plus any
 * extra faces through this hook.
 */
export interface ScopeAwareFilter {
  setScopeIndex(solids: Solid[], extraFaces: Face[]): void;
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
 */
export function injectFilterScope(
  filters: FilterBuilderBase<Shape>[],
  resolveScope: () => FilterScope,
): void {
  let scope: FilterScope | null = null;

  for (const builder of filters) {
    for (const filter of builder.getFilters()) {
      if (!isScopeAware(filter)) {
        continue;
      }
      if (!scope) {
        scope = resolveScope();
      }
      filter.setScopeIndex(scope.solids, scope.extraFaces);
    }
  }
}

/** True when any builder carries a filter that needs scope injection. */
export function needsFilterScope(filters: FilterBuilderBase<Shape>[]): boolean {
  return filters.some(builder => builder.getFilters().some(isScopeAware));
}
