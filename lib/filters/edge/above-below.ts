import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

export class AbovePlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
    const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
    const firstAbove = plane.signedDistanceToPoint(firstPoint) > 0;
    const lastAbove = plane.signedDistanceToPoint(lastPoint) > 0;
    if (this.partial) {
      return firstAbove || lastAbove;
    }
    return firstAbove && lastAbove;
  }

  compareTo(other: AbovePlaneFilter): boolean {
    return this.plane.compareTo(other.plane) && this.partial === other.partial;
  }

  transform(matrix: Matrix4): AbovePlaneFilter {
    const transformedPlane = this.plane.getPlane().applyMatrix(matrix);
    return new AbovePlaneFilter(new PlaneObject(transformedPlane), this.partial);
  }
}

export class BelowPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = this.plane.getPlane();
    const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
    const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
    const firstBelow = plane.signedDistanceToPoint(firstPoint) < 0;
    const lastBelow = plane.signedDistanceToPoint(lastPoint) < 0;
    if (this.partial) {
      return firstBelow || lastBelow;
    }
    return firstBelow && lastBelow;
  }

  compareTo(other: BelowPlaneFilter): boolean {
    return this.plane.compareTo(other.plane) && this.partial === other.partial;
  }

  transform(matrix: Matrix4): BelowPlaneFilter {
    const transformedPlane = this.plane.getPlane().applyMatrix(matrix);
    return new BelowPlaneFilter(new PlaneObject(transformedPlane), this.partial);
  }
}

