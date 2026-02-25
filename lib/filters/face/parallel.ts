import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class ParallelFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    return FaceQuery.isFaceParallelToPlane(shape, plane);
  }

  compareTo(other: ParallelFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): ParallelFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new ParallelFilter(planeObj);
  }
}

export class NotParallelFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    return !FaceQuery.isFaceParallelToPlane(shape, plane);
  }

  compareTo(other: NotParallelFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): NotParallelFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new NotParallelFilter(planeObj);
  }
}
