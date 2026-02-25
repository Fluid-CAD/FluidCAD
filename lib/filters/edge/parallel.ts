import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class ParallelPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase) {
    super()
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    return EdgeQuery.isEdgeParallelToPlane(shape, plane.normal);
  }

  compareTo(other: ParallelPlaneFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): ParallelPlaneFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new ParallelPlaneFilter(planeObj);
  }
}

export class NotParallelPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    return !EdgeQuery.isEdgeParallelToPlane(shape, plane.normal);
  }

  compareTo(other: NotParallelPlaneFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): NotParallelPlaneFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new NotParallelPlaneFilter(planeObj);
  }
}
