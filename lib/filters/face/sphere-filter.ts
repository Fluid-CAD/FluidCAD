import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class SphereFilter extends FilterBase<Face> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isSphereFace(shape, this.diameter);
  }

  compareTo(other: SphereFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): SphereFilter {
    return new SphereFilter(this.diameter);
  }
}

export class NotSphereFilter extends FilterBase<Face> {
  constructor(private diameter?: number) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isSphereFace(shape, this.diameter);
  }

  compareTo(other: NotSphereFilter): boolean {
    return this.diameter === other.diameter;
  }

  transform(matrix: Matrix4): NotSphereFilter {
    return new NotSphereFilter(this.diameter);
  }
}
