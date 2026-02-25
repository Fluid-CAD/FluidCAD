import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class CircleFilter extends FilterBase<Edge> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return EdgeQuery.isCircleEdge(shape, this.radius);
  }

  compareTo(other: CircleFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): CircleFilter {
    return new CircleFilter(this.radius);
  }
}

export class NotCircleFilter extends FilterBase<Edge> {

  constructor(private radius?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return !EdgeQuery.isCircleEdge(shape, this.radius);
  }

  compareTo(other: NotCircleFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): NotCircleFilter {
    return new NotCircleFilter(this.radius);
  }
}
