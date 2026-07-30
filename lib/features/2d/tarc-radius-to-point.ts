import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";

/**
 * Tangent arc with an explicit radius, aimed at a given point. Tangency to
 * the chain is always preserved: the radius fixes the arc's circle (one on
 * each side of the start tangent — the endpoint picks the nearer side), and
 * the arc ends at the point on that circle closest to `endPoint`. An
 * endpoint lying on the circle is hit exactly, so passing the auto-solved
 * radius reproduces `tArc(endPoint)`. A negative radius leaves the start
 * against the chain tangent, flipping the arc to the other side.
 */
export class TangentArcRadiusToPoint extends GeometrySceneObject {

  constructor(
    public radius: number,
    public endPoint: LazyVertex) {
    super();
  }

  build(): void {
    const chainTangent = this.sketch.getTangentAt(this).normalize();
    const plane = this.sketch.getPlane();
    const startPoint = this.getCurrentPosition();
    const aimPoint = this.endPoint.asPoint2D();

    const absRadius = Math.abs(this.radius);
    if (!(absRadius > 0)) {
      throw new Error('TangentArcRadiusToPoint: radius must be non-zero');
    }

    // The circle is tangent to the leave direction at the start — one
    // candidate on each side; the aim point picks the nearer one.
    const leave = this.radius >= 0 ? chainTangent : chainTangent.negate();
    const leavePerp = new Point2D(-leave.y, leave.x);
    const leftCenter = startPoint.add(leavePerp.multiplyScalar(absRadius));
    const rightCenter = startPoint.subtract(leavePerp.multiplyScalar(absRadius));
    const cw = aimPoint.distanceTo(rightCenter) < aimPoint.distanceTo(leftCenter);
    const centerPoint = cw ? rightCenter : leftCenter;

    const toAim = aimPoint.subtract(centerPoint);
    const aimDist = toAim.length();
    if (aimDist < 1e-9) {
      throw new Error('TangentArcRadiusToPoint: endpoint coincides with the arc center — the end direction is ambiguous');
    }
    const targetPoint = centerPoint.add(toAim.multiplyScalar(absRadius / aimDist));
    if (targetPoint.distanceTo(startPoint) < 1e-9) {
      throw new Error('TangentArcRadiusToPoint: endpoint projects onto the start point — the arc has no sweep');
    }

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

    const arc = Geometry.makeArc(center, absRadius, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const sign = cw ? -1 : 1;
    const endTx = sign * (-Math.sin(endAngle));
    const endTy = sign * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(targetPoint));
    this.addShape(edge);
    const centerVertex = Vertex.fromPoint(center);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
    this.setCurrentPosition(targetPoint);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new TangentArcRadiusToPoint(this.radius, this.endPoint);
  }

  compareTo(other: TangentArcRadiusToPoint): boolean {
    if (!(other instanceof TangentArcRadiusToPoint)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.radius === other.radius && this.endPoint.compareTo(other.endPoint);
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'tarc-radius-to-point';
  }

  serialize() {
    return {
      radius: this.radius,
      endPoint: this.endPoint.serialize()
    }
  }
}
