import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";

/** An edge whose ends are apart: the complement of `ClosedFilter`. */
export class OpenFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return !CurveClassifier.classify(shape).closed;
  }

  compareTo(other: OpenFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): OpenFilter {
    return new OpenFilter();
  }
}

export class NotOpenFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).closed;
  }

  compareTo(other: NotOpenFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotOpenFilter {
    return new NotOpenFilter();
  }
}
