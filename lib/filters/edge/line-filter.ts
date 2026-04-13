import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class LineFilter extends FilterBase<Edge> {
  constructor(private length?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return EdgeQuery.isLineEdge(shape, this.length);
  }

  compareTo(other: LineFilter): boolean {
    return this.length === other.length;
  }

  transform(matrix: Matrix4): LineFilter {
    return new LineFilter(this.length);
  }
}

export class NotLineFilter extends FilterBase<Edge> {
  constructor(private length?: number) {
    super();
  }

  match(shape: Edge): boolean {
    return !EdgeQuery.isLineEdge(shape, this.length);
  }

  compareTo(other: NotLineFilter): boolean {
    return this.length === other.length;
  }

  transform(matrix: Matrix4): NotLineFilter {
    return new NotLineFilter(this.length);
  }
}
