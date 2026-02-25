import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class LineFilter extends FilterBase<Edge> {
  constructor() {
    super();
  }

  match(shape: Edge): boolean {
    return EdgeQuery.isLineEdge(shape);
  }

  compareTo(other: LineFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): LineFilter {
    return new LineFilter();
  }
}

export class NotLineFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return !EdgeQuery.isLineEdge(shape);
  }

  compareTo(other: NotLineFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotLineFilter {
    return new NotLineFilter();
  }
}
