import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";

export class ArcToPoint extends GeometrySceneObject {
  constructor(
    public endPoint: LazyVertex,
    public radius: number = 0,
    private targetPlane: PlaneObjectBase = null
  ) {
    super();
  }

  build(): void {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const targetPoint = this.endPoint.asPoint2D();

    const startPoint = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const dx = targetPoint.x - startPoint.x;
    const dy = targetPoint.y - startPoint.y;
    const chordLen = Math.sqrt(dx * dx + dy * dy);

    // Default radius: semicircle (half the chord length)
    let r = this.radius || (chordLen / 2);
    const cw = r < 0;
    r = Math.abs(r);

    // Ensure radius is at least half chord length
    if (r < chordLen / 2) {
      r = chordLen / 2;
    }

    // Find center using perpendicular bisector + radius constraint
    const mx = (startPoint.x + targetPoint.x) / 2;
    const my = (startPoint.y + targetPoint.y) / 2;

    // Perpendicular direction to chord (normalized)
    const px = -dy / chordLen;
    const py = dx / chordLen;

    // Distance from midpoint to center along perpendicular
    const d = Math.sqrt(r * r - (chordLen / 2) * (chordLen / 2));

    // Choose side based on CW/CCW
    const sign = cw ? -1 : 1;
    const centerPoint = new Point2D(mx + sign * d * px, my + sign * d * py);

    const startAngle = Math.atan2(startPoint.y - centerPoint.y, startPoint.x - centerPoint.x);
    const endAngle = Math.atan2(targetPoint.y - centerPoint.y, targetPoint.x - centerPoint.x);

    const normal = cw ? plane.normal.negate() : plane.normal;

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(targetPoint);

    const arc = Geometry.makeArc(center, r, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    // Tangent at end: perpendicular to radius direction at end point
    // CCW: (-sin θ, cos θ), CW: (sin θ, -cos θ)
    const signT = cw ? -1 : 1;
    const endTx = signT * (-Math.sin(endAngle));
    const endTy = signT * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(targetPoint));
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(targetPoint);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  compareTo(other: ArcToPoint): boolean {
    if (!(other instanceof ArcToPoint)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }
    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    return this.endPoint.compareTo(other.endPoint) &&
      this.radius === other.radius;
  }

  getType(): string {
    return 'arc';
  }

  getUniqueType(): string {
    return 'arc-to-point';
  }

  serialize() {
    return {
      endPoint: this.endPoint.serialize(),
      radius: this.radius
    };
  }
}
