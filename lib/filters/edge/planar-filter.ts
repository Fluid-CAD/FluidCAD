import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";

/** An edge that lies in one plane: every line, circle and ellipse, and a spline drawn flat; see {@link CurveClassifier}. */
export class PlanarCurveFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return CurveClassifier.classify(shape).planar;
  }

  compareTo(other: PlanarCurveFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): PlanarCurveFilter {
    return new PlanarCurveFilter();
  }
}

export class NotPlanarCurveFilter extends FilterBase<Edge> {
  match(shape: Edge): boolean {
    return !CurveClassifier.classify(shape).planar;
  }

  compareTo(other: NotPlanarCurveFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotPlanarCurveFilter {
    return new NotPlanarCurveFilter();
  }
}
