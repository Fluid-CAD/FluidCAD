import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class OnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    return EdgeQuery.isEdgeOnPlane(shape, plane);
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

export class NotOnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    return !EdgeQuery.isEdgeOnPlane(shape, plane);
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
