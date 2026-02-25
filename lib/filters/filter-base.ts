import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Comparable } from "../common/scene-object.js";
import { Shape } from "../common/shapes.js";

export abstract class FilterBase<TShape extends Shape> implements Comparable<FilterBase<TShape>> {
  abstract match(shape: TShape): boolean;
  abstract compareTo(other: FilterBase<TShape>): boolean;
  abstract transform(matrix: Matrix4): FilterBase<TShape>;
}
