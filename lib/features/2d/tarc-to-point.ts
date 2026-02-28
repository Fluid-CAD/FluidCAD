import { Edge } from "../../common/edge.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";

export class TangentArcToPoint extends GeometrySceneObject {

  constructor(
    public endPoint: LazyVertex) {
    super();
  }

  build(): void {
    const tangent = this.sketch.getTangentAt(this);
    if (!tangent) {
      throw new Error('TangentArcToPoint requires a previous sibling with a tangent');
    }
    const plane = this.sketch.getPlane();
    const startPoint = this.getCurrentPosition();
    const targetPoint = this.endPoint.asPoint2D();

    // Normal to tangent (perpendicular, pointing left for CCW)
    const norm = tangent.normalize();
    const perpendicular = new Point2D(-norm.y, norm.x);

    // Find circle center using perpendicular bisector constraint:
    // Center lies on perpendicular to tangent through start, equidistant from both points
    const d = startPoint.subtract(targetPoint);
    const distSq = startPoint.distanceToSquared(targetPoint);

    const dDotN = d.x * perpendicular.x + d.y * perpendicular.y;
    if (Math.abs(dDotN) < 1e-10) {
      throw new Error('TangentArcToPoint: endpoint is collinear with tangent direction');
    }

    // Signed parameter: positive = CCW, negative = CW
    const t = -distSq / (2 * dDotN);
    const radius = Math.abs(t);
    const cw = t < 0;

    const centerPoint = startPoint.add(perpendicular.multiplyScalar(t));

    // Compute angles on the circle
    const startAngle = Math.atan2(startPoint.y - centerPoint.y, startPoint.x - centerPoint.x);
    const endAngle = Math.atan2(targetPoint.y - centerPoint.y, targetPoint.x - centerPoint.x);

    let sweep = endAngle - startAngle;
    if (cw) {
      if (sweep > 0) { sweep -= 2 * Math.PI; }
    } else {
      if (sweep < 0) { sweep += 2 * Math.PI; }
    }

    const normal = cw ? plane.normal.negate() : plane.normal;

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(targetPoint);

    const arc = Geometry.makeArc(center, radius, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    // Tangent at end: perpendicular to radius direction at end point
    // CCW: (-sin θ, cos θ), CW: (sin θ, -cos θ)
    const sign = cw ? -1 : 1;
    const endTx = sign * (-Math.sin(endAngle));
    const endTy = sign * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('edge', edge);
    this.addShape(edge);
    this.setCurrentPosition(targetPoint);
  }

  compareTo(other: TangentArcToPoint): boolean {
    if (!(other instanceof TangentArcToPoint)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.endPoint.compareTo(other.endPoint);
  }

  start(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('start-vertex'), () => {
      const edge = this.getState('edge') as Edge;
      return edge ? [edge.getFirstVertex()] : [];
    });
  }

  end(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('end-vertex'), () => {
      const edge = this.getState('edge') as Edge;
      return edge ? [edge.getLastVertex()] : [];
    });
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'tarc-to-point';
  }

  serialize() {
    return {
      endPoint: this.endPoint.serialize()
    }
  }
}
