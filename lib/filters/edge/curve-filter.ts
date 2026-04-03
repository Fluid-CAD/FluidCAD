import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class CircleCurveFilter extends FilterBase<Edge> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return EdgeQuery.isArcEdge(shape, this.diameter);
  }

  compareTo(other: CircleCurveFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): CircleCurveFilter {
    return new CircleCurveFilter(this.diameter);
  }
}

export class NotCircleCurveFilter extends FilterBase<Edge> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return !EdgeQuery.isArcEdge(shape, this.diameter);
  }

  compareTo(other: NotCircleCurveFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): NotCircleCurveFilter {
    return new NotCircleCurveFilter(this.diameter);
  }
}
