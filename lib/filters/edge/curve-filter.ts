import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class ArcFilter extends FilterBase<Edge> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return EdgeQuery.isArcEdge(shape, this.radius);
  }

  compareTo(other: ArcFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): ArcFilter {
    return new ArcFilter(this.radius);
  }
}

export class NotArcFilter extends FilterBase<Edge> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return !EdgeQuery.isArcEdge(shape, this.radius);
  }

  compareTo(other: NotArcFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): NotArcFilter {
    return new NotArcFilter(this.radius);
  }
}
