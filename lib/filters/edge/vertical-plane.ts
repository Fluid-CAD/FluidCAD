import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class VerticalFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    return EdgeQuery.isEdgeAlignedWithNormal(shape, plane.normal);
  }

  compareTo(other: VerticalFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): VerticalFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new VerticalFilter(planeObj);
  }
}

export class NotVerticalFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    return !EdgeQuery.isEdgeAlignedWithNormal(shape, plane.normal);
  }

  compareTo(other: NotVerticalFilter): boolean {
    return this.plane.compareTo(other.plane);
  }

  transform(matrix: Matrix4): NotVerticalFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new NotVerticalFilter(planeObj);
  }
}
