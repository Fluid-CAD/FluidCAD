import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";

export class ArcFromTwoAngles extends GeometrySceneObject {
  constructor(
    public radius: number,
    public startAngle: number,
    public endAngle: number,
    private targetPlane: PlaneObjectBase = null) {
    super();
  }

  build(): void {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const radius = this.radius;

    // Negative angles indicate a clockwise arc
    const cw = this.startAngle < 0 || this.endAngle < 0;
    const absStartAngle = Math.abs(this.startAngle);
    const absEndAngle = Math.abs(this.endAngle);

    // For CW, flip the center to the opposite side and negate the normal
    const startAngleRad = cw ? rad(absStartAngle) + Math.PI : rad(absStartAngle);
    const endAngleRad = cw ? rad(absEndAngle) + Math.PI : rad(absEndAngle);
    const normal = cw ? plane.normal.negate() : plane.normal;

    const startPoint = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const centerPoint = Geometry.getCircleCenter(startPoint, radius, startAngleRad);

    const endPoint = Geometry.getPointOnCircle(centerPoint, radius, endAngleRad);

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    const arc = Geometry.makeArc(center, radius, normal, start, end)
    const edge = Geometry.makeEdgeFromCurve(arc);

    // const circle = Geometry.makeCircle(center, radius, normal);
    // const circleEdge = Geometry.makeEdgeFromCircle(circle);
    // circleEdge.markAsMetaShape();

    // this.addShape(circleEdge);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));

    // get tangent as unit Point2D
    // CCW: (-sin θ, cos θ), CW: (sin θ, -cos θ)
    const origEndAngleRad = rad(absEndAngle);
    const sign = cw ? -1 : 1;
    const tx = sign * (-Math.sin(origEndAngleRad));
    const ty = sign * Math.cos(origEndAngleRad);

    this.setTangent(new Point2D(tx, ty));

    this.addShape(edge);
    if (this.sketch) {
      this.setCurrentPosition(endPoint);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  getType(): string {
    return 'arc';
  }

  compareTo(other: ArcFromTwoAngles): boolean {
    if (!(other instanceof ArcFromTwoAngles)) {
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

    return this.radius === other.radius &&
      this.startAngle === other.startAngle &&
      this.endAngle === other.endAngle;
  }

  serialize() {
    return {
      radius: this.radius,
      startAngle: this.startAngle,
      endAngle: this.endAngle,
    }
  }
}
