import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Explorer } from "../../oc/explorer.js";

export class OnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase, private plane2?: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    console.log('******** Edge type:', Explorer.getShapeType(shape.getShape()));
    if (EdgeQuery.isEdgeOnPlane(shape, plane)) {
      return true;
    }
    if (this.plane2) {
      return EdgeQuery.isEdgeOnPlane(shape, this.plane2.getPlane());
    }
    return false;
  }

  compareTo(other: OnPlaneFilter): boolean {
    if (!this.plane.compareTo(other.plane)) {
      return false;
    }
    if (this.plane2 && other.plane2) {
      return this.plane2.compareTo(other.plane2);
    }
    return this.plane2 === other.plane2;
  }

  transform(matrix: Matrix4): OnPlaneFilter {
    const plane = this.plane.getPlane();
    const transformedPlane = plane.applyMatrix(matrix);
    console.log('Plane', plane.normal, 'Origin:', plane.origin, ' Transformed plane:', transformedPlane.normal, ' Origin:', transformedPlane.origin);
    const planeObj = new PlaneObject(transformedPlane);
    const planeObj2 = this.plane2 ? new PlaneObject(this.plane2.getPlane().applyMatrix(matrix)) : undefined;
    return new OnPlaneFilter(planeObj, planeObj2);
  }
}

export class NotOnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase, private plane2?: PlaneObjectBase) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    if (this.plane2) {
      return !EdgeQuery.isEdgeOnPlane(shape, plane) && !EdgeQuery.isEdgeOnPlane(shape, this.plane2.getPlane());
    }
    return !EdgeQuery.isEdgeOnPlane(shape, plane);
  }

  compareTo(other: NotOnPlaneFilter): boolean {
    if (!this.plane.compareTo(other.plane)) {
      return false;
    }
    if (this.plane2 && other.plane2) {
      return this.plane2.compareTo(other.plane2);
    }
    return this.plane2 === other.plane2;
  }

  transform(matrix: Matrix4): NotOnPlaneFilter {
    const plane = this.plane.getPlane();
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    const planeObj2 = this.plane2 ? new PlaneObject(this.plane2.getPlane().applyMatrix(matrix)) : undefined;
    return new NotOnPlaneFilter(planeObj, planeObj2);
  }
}
