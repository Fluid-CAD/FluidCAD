import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class TorusFilter extends FilterBase<Face> {
  constructor(private majorRadius?: number, private minorRadius?: number) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isTorusFace(shape, this.majorRadius, this.minorRadius);
  }

  compareTo(other: TorusFilter): boolean {
    return this.majorRadius === other.majorRadius && this.minorRadius === other.minorRadius;
  }

  transform(matrix: Matrix4): TorusFilter {
    return new TorusFilter(this.majorRadius, this.minorRadius);
  }
}

export class NotTorusFilter extends FilterBase<Face> {
  constructor(private majorRadius?: number, private minorRadius?: number) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isTorusFace(shape, this.majorRadius, this.minorRadius);
  }

  compareTo(other: NotTorusFilter): boolean {
    return this.majorRadius === other.majorRadius && this.minorRadius === other.minorRadius;
  }

  transform(matrix: Matrix4): NotTorusFilter {
    return new NotTorusFilter(this.majorRadius, this.minorRadius);
  }
}
