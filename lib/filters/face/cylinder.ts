import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class CylinderFilter extends FilterBase<Face> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isCylinderFace(shape, this.diameter);
  }

  compareTo(other: CylinderFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): CylinderFilter {
    return new CylinderFilter(this.diameter);
  }
}

export class NotCylinderFilter extends FilterBase<Face> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isCylinderFace(shape, this.diameter);
  }

  compareTo(other: NotCylinderFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): NotCylinderFilter {
    return new NotCylinderFilter(this.diameter);
  }
}
