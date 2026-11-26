import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";

/** An edge that returns to its start: a full circle, a full ellipse, a closed spline. */
export class ClosedFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).closed;
  }

  compareTo(other: ClosedFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): ClosedFilter {
    return new ClosedFilter();
  }
}

export class NotClosedFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return !CurveClassifier.classify(shape).closed;
  }

  compareTo(other: NotClosedFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotClosedFilter {
    return new NotClosedFilter();
  }
}
