import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class IntersectsWithFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    return FaceQuery.doesFaceIntersectPlane(shape, plane);
  }

  compareTo(other: IntersectsWithFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): IntersectsWithFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new IntersectsWithFilter(planeObj);
  }
}

export class NotIntersectsWithFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    return !FaceQuery.doesFaceIntersectPlane(shape, plane);
  }

  compareTo(other: NotIntersectsWithFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): NotIntersectsWithFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new NotIntersectsWithFilter(planeObj);
  }
}
