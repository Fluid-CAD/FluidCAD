import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class CircleFilter extends FilterBase<Face> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isCircleFace(shape, this.radius);
  }

  compareTo(other: CircleFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): CircleFilter {
    return new CircleFilter(this.radius);
  }
}

export class NotCircleFilter extends FilterBase<Face> {
  constructor(private radius?: number) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isCircleFace(shape, this.radius);
  }

  compareTo(other: NotCircleFilter): boolean {
    return this.radius === other.radius;
  }

  transform(matrix: Matrix4): NotCircleFilter {
    return new NotCircleFilter(this.radius);
  }
}
