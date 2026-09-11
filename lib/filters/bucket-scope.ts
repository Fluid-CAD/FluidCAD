import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { SceneObject } from "../common/scene-object.js";
import { ShapeFilter } from "./filter.js";
import { FilterBuilderBase } from "./filter-builder-base.js";
import { injectFilterScope } from "./scope-injection.js";

/**
 * Run filter builders over a feature's classified bucket members
 * (`e.sideEdges(edge().convex())`), giving scope-aware filters the feature's
 * own as-built solid to look up adjacency in. `getAddedShapes` deliberately
 * ignores removals: a bucket records its members as built, and the solid
 * they belong to may since have been consumed by a later boolean — the
 * as-built solid is still the one whose topology the members index.
 */
export function applyBucketFilters<T extends Shape>(
  shapes: T[],
  builders: FilterBuilderBase<T>[],
  owner: SceneObject,
): T[] {
  const hasher = injectFilterScope(builders as unknown as FilterBuilderBase<Shape>[], () => ({
    solids: owner.getAddedShapes().filter((s): s is Solid => s instanceof Solid),
    extraFaces: [],
  }));
  try {
    return new ShapeFilter(shapes, ...(builders as unknown as FilterBuilderBase<Shape>[])).apply() as T[];
  } finally {
    hasher?.delete();
  }
}
