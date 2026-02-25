import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class CircleCurveFilter extends FilterBase<Edge> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return EdgeQuery.isArcEdge(shape, this.radius);
  }

  compareTo(other: CircleCurveFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): CircleCurveFilter {
    return new CircleCurveFilter(this.radius);
  }
}

export class NotCircleCurveFilter extends FilterBase<Edge> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return !EdgeQuery.isArcEdge(shape, this.radius);
  }

  compareTo(other: NotCircleCurveFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): NotCircleCurveFilter {
    return new NotCircleCurveFilter(this.radius);
  }
}
