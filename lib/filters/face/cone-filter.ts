import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class ConeFilter extends FilterBase<Face> {
  constructor() {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isConeFace(shape);
  }

  compareTo(other: ConeFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): ConeFilter {
    return new ConeFilter();
  }
}

export class NotConeFilter extends FilterBase<Face> {
  constructor() {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isConeFace(shape);
  }

  compareTo(other: NotConeFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotConeFilter {
    return new NotConeFilter();
  }
}
