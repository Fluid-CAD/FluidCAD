import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class OnPlaneFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    return FaceQuery.isFaceOnPlane(shape, plane);
  }

  compareTo(other: OnPlaneFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): OnPlaneFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new OnPlaneFilter(planeObj);
  }
}

export class NotOnPlaneFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    return !FaceQuery.isFaceOnPlane(shape, plane);
  }

  compareTo(other: NotOnPlaneFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): NotOnPlaneFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new NotOnPlaneFilter(planeObj);
  }
}
