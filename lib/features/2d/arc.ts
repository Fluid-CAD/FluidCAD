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
    public centered: boolean = false,
    private targetPlane: PlaneObjectBase = null) {
    super();
  }

  build(): void {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const radius = this.radius;

    // Current position (or plane center) is the center of the arc
    const centerPoint = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    // Negative angles indicate a clockwise arc
    const cw = this.endAngle < 0;
    const absStartAngle = Math.abs(this.startAngle);
    const absEndAngle = Math.abs(this.endAngle);

    let startAngleRad: number;
    let endAngleRad: number;

    if (this.centered) {
      // Centered: the sweep is split equally around startAngle
      const halfSweep = rad(absEndAngle) / 2;
      const midAngle = rad(absStartAngle);
      startAngleRad = midAngle - halfSweep;
      endAngleRad = midAngle + halfSweep;
    } else {
      startAngleRad = rad(absStartAngle);
      endAngleRad = rad(absEndAngle);
    }

    const normal = cw ? plane.normal.negate() : plane.normal;

    const startPoint = Geometry.getPointOnCircle(centerPoint, radius, startAngleRad);
    const endPoint = Geometry.getPointOnCircle(centerPoint, radius, endAngleRad);

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    const arc = Geometry.makeArc(center, radius, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));

    // Tangent at end point: CCW: (-sin θ, cos θ), CW: (sin θ, -cos θ)
    const sign = cw ? -1 : 1;
    const tx = sign * (-Math.sin(endAngleRad));
    const ty = sign * Math.cos(endAngleRad);

    this.setTangent(new Point2D(tx, ty));

    this.addShape(edge);

    // Current position should NOT change — the center remains the current position

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
      this.endAngle === other.endAngle &&
      this.centered === other.centered;
  }

  serialize() {
    return {
      radius: this.radius,
      startAngle: this.startAngle,
      endAngle: this.endAngle,
      centered: this.centered,
    }
  }
}
