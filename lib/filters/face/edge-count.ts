import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";

export class EdgeCountFilter extends FilterBase<Face> {
  constructor(private count: number) {
    super();
  }

  match(shape: Face): boolean {
    return shape.getEdges().length === this.count;
  }

  compareTo(other: EdgeCountFilter): boolean {
    return this.count === other.count;
  }

  transform(matrix: Matrix4): EdgeCountFilter {
    return new EdgeCountFilter(this.count);
  }
}

export class NotEdgeCountFilter extends FilterBase<Face> {
  constructor(private count: number) {
    super();
  }

  match(shape: Face): boolean {
    return shape.getEdges().length !== this.count;
  }

  compareTo(other: NotEdgeCountFilter): boolean {
    return this.count === other.count;
  }

  transform(matrix: Matrix4): NotEdgeCountFilter {
    return new NotEdgeCountFilter(this.count);
  }
}
