import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";

/** A free-form edge: a B-spline or Bezier curve that is no line, circle or ellipse; see {@link CurveClassifier}. */
export class SplineFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).kind === 'spline';
  }

  compareTo(other: SplineFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): SplineFilter {
    return new SplineFilter();
  }
}

export class NotSplineFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).kind !== 'spline';
  }

  compareTo(other: NotSplineFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotSplineFilter {
    return new NotSplineFilter();
  }
}
