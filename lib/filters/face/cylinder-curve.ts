import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class CylinderCurveFilter extends FilterBase<Face> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isCylinderCurveFace(shape, this.radius);
  }

  compareTo(other: CylinderCurveFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): CylinderCurveFilter {
    return new CylinderCurveFilter(this.radius);
  }
}

export class NotCylinderCurveFilter extends FilterBase<Face> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isCylinderCurveFace(shape, this.radius);
  }

  compareTo(other: NotCylinderCurveFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): NotCylinderCurveFilter {
    return new NotCylinderCurveFilter(this.radius);
  }
}
