import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class OnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase, private plane2?: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    if (this.partial) {
      const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
      const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
      if (plane.containsPoint(firstPoint) || plane.containsPoint(lastPoint)) {
        return true;
      }
      if (this.plane2) {
        const plane2 = this.plane2.getPlane();
        return plane2.containsPoint(firstPoint) || plane2.containsPoint(lastPoint);
      }
      return false;
    }
    if (EdgeQuery.isEdgeOnPlane(shape, plane)) {
      return true;
    }
    if (this.plane2) {
      return EdgeQuery.isEdgeOnPlane(shape, this.plane2.getPlane());
    }
    return false;
  }

  compareTo(other: OnPlaneFilter): boolean {
    if (!this.plane.compareTo(other.plane) || this.partial !== other.partial) {
      return false;
    }
    if (this.plane2 && other.plane2) {
      return this.plane2.compareTo(other.plane2);
    }
    return this.plane2 === other.plane2;
  }

  transform(matrix: Matrix4): OnPlaneFilter {
    const transformedPlane = this.plane.getPlane().applyMatrix(matrix);
    const planeObj2 = this.plane2 ? new PlaneObject(this.plane2.getPlane().applyMatrix(matrix)) : undefined;
    return new OnPlaneFilter(new PlaneObject(transformedPlane), planeObj2, this.partial);
  }
}

export class NotOnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase, private plane2?: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    if (this.partial) {
      const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
      const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
      if (plane.containsPoint(firstPoint) || plane.containsPoint(lastPoint)) {
        return false;
      }
      if (this.plane2) {
        const plane2 = this.plane2.getPlane();
        return !plane2.containsPoint(firstPoint) && !plane2.containsPoint(lastPoint);
      }
      return true;
    }
    if (this.plane2) {
      return !EdgeQuery.isEdgeOnPlane(shape, plane) && !EdgeQuery.isEdgeOnPlane(shape, this.plane2.getPlane());
    }
    return !EdgeQuery.isEdgeOnPlane(shape, plane);
  }

  compareTo(other: NotOnPlaneFilter): boolean {
    if (!this.plane.compareTo(other.plane) || this.partial !== other.partial) {
      return false;
    }
    if (this.plane2 && other.plane2) {
      return this.plane2.compareTo(other.plane2);
    }
    return this.plane2 === other.plane2;
  }

  transform(matrix: Matrix4): NotOnPlaneFilter {
    const transformedPlane = this.plane.getPlane().applyMatrix(matrix);
    const planeObj2 = this.plane2 ? new PlaneObject(this.plane2.getPlane().applyMatrix(matrix)) : undefined;
    return new NotOnPlaneFilter(new PlaneObject(transformedPlane), planeObj2, this.partial);
  }
}
