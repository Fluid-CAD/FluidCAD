import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class CylinderCurveFilter extends FilterBase<Face> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isCylinderCurveFace(shape, this.diameter);
  }

  compareTo(other: CylinderCurveFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): CylinderCurveFilter {
    return new CylinderCurveFilter(this.diameter);
  }
}

export class NotCylinderCurveFilter extends FilterBase<Face> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isCylinderCurveFace(shape, this.diameter);
  }

  compareTo(other: NotCylinderCurveFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): NotCylinderCurveFilter {
    return new NotCylinderCurveFilter(this.diameter);
  }
}
