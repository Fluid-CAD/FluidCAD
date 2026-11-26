import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";

/** An edge on an ellipse, full or an arc of one; see {@link CurveClassifier}. */
export class EllipseFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).kind === 'ellipse';
  }

  compareTo(other: EllipseFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): EllipseFilter {
    return new EllipseFilter();
  }
}

export class NotEllipseFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).kind !== 'ellipse';
  }

  compareTo(other: NotEllipseFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotEllipseFilter {
    return new NotEllipseFilter();
  }
}
