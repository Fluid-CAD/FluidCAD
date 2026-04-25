import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Comparable, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shapes.js";

export abstract class FilterBase<TShape extends Shape> implements Comparable<FilterBase<TShape>> {
  abstract match(shape: TShape): boolean;
  abstract compareTo(other: FilterBase<TShape>): boolean;
  abstract transform(matrix: Matrix4): FilterBase<TShape>;

  /**
   * Returns a copy of this filter with any internal SceneObject references
   * rewritten through the given remap. Filters that don't hold SceneObject
   * references can keep the default no-op.
   */
  remap(_remap: Map<SceneObject, SceneObject>): FilterBase<TShape> {
    return this;
  }
}
