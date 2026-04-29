import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";

function getBoundaryPoints(face: Face) {
  return face.getEdges().flatMap(edge => [
    EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(edge)),
    EdgeOps.getVertexPoint(EdgeOps.getLastVertex(edge)),
  ]);
}

export class AboveFacePlaneFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    const flags = getBoundaryPoints(shape).map(p => plane.signedDistanceToPoint(p) > 0);
    if (flags.length === 0) {
      return false;
    }
    return this.partial ? flags.some(Boolean) : flags.every(Boolean);
  }

  compareTo(other: AboveFacePlaneFilter): boolean {
    return this.plane.compareTo(other.plane) && this.partial === other.partial;
  }

  transform(matrix: Matrix4): AboveFacePlaneFilter {
    const transformedPlane = this.plane.getPlane().applyMatrix(matrix);
    return new AboveFacePlaneFilter(new PlaneObject(transformedPlane), this.partial);
  }
}

export class BelowFacePlaneFilter extends FilterBase<Face> {
  constructor(private plane: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Face): boolean {
    const plane = this.plane.getPlane();
    const flags = getBoundaryPoints(shape).map(p => plane.signedDistanceToPoint(p) < 0);
    if (flags.length === 0) {
      return false;
    }
    return this.partial ? flags.some(Boolean) : flags.every(Boolean);
  }

  compareTo(other: BelowFacePlaneFilter): boolean {
    return this.plane.compareTo(other.plane) && this.partial === other.partial;
  }

  transform(matrix: Matrix4): BelowFacePlaneFilter {
    const transformedPlane = this.plane.getPlane().applyMatrix(matrix);
    return new BelowFacePlaneFilter(new PlaneObject(transformedPlane), this.partial);
  }
}
