import { Matrix4 } from "../math/matrix4.js";
import { Comparable, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shapes.js";

/**
 * One stage of a filter chain. Most filters are per-shape predicates and only
 * implement {@link match}; the default {@link apply} runs that predicate over
 * the candidates. Set-level filters — extremes along a direction, largest /
 * smallest, nth layer — need every candidate at once and override
 * {@link apply} instead (their `match` is never called by the pipeline).
 *
 * Stages run in chain order over the survivors of the previous stage, so
 * `edge().line().farthest('z')` is "the topmost layer among the lines" and
 * `edge().farthest('z').line()` is "the lines within the topmost layer".
 */
export abstract class FilterBase<TShape extends Shape> implements Comparable<FilterBase<TShape>> {
  abstract match(shape: TShape): boolean;
  abstract compareTo(other: FilterBase<TShape>): boolean;
  abstract transform(matrix: Matrix4): FilterBase<TShape>;

  /**
   * Run this stage over the candidates, preserving their order. The default
   * keeps every shape the per-shape predicate accepts; a predicate that throws
   * logs the error and drops that shape (the historical per-shape behavior).
   */
  apply(shapes: TShape[]): TShape[] {
    const kept: TShape[] = [];
    for (const shape of shapes) {
      try {
        if (this.match(shape)) {
          kept.push(shape);
        }
      }
      catch (e) {
        console.error('Error applying filter:', e, this);
      }
    }
    return kept;
  }

  /**
   * Returns a copy of this filter with any internal SceneObject references
   * rewritten through the given remap. Filters that don't hold SceneObject
   * references can keep the default no-op.
   */
  remap(_remap: Map<SceneObject, SceneObject>): FilterBase<TShape> {
    return this;
  }

  /**
   * SceneObjects this filter references and resolves lazily (a plane-ref
   * selection, for instance) — surfaced so a consuming select() can list
   * them as dependencies. Filters without references keep the default.
   */
  getSceneObjectRefs(): SceneObject[] {
    return [];
  }
}

/**
 * Run a filter chain stage by stage over `shapes`, in chain order. The one
 * evaluator every consumer of a builder's filters must use — `ShapeFilter`,
 * and the nested builders inside `belongsToFace(face()...)` — so set-level
 * stages behave identically everywhere.
 */
export function applyFilterStages<TShape extends Shape>(shapes: TShape[], filters: FilterBase<TShape>[]): TShape[] {
  let survivors = shapes;
  for (const filter of filters) {
    if (survivors.length === 0) {
      break;
    }
    try {
      survivors = filter.apply(survivors);
    }
    catch (e) {
      console.error('Error applying filter:', e, filter);
      return [];
    }
  }
  return survivors;
}
