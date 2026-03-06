import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D } from "../../math/point.js";
import { LazyVertex } from "../lazy-vertex.js";
import { GeometrySceneObject } from "./geometry.js";

export class TangentArcWithTangent extends GeometrySceneObject {

  constructor(
    public radius: number,
    public endAngle: number,
    public startTangent: LazyVertex
  ) {
    super();
  }

  build(): void {
    const plane = this.sketch.getPlane();
    const radius = this.radius;

    const tangent = this.startTangent.asPoint2D();

    // Derive the base angle from the provided tangent.
    // Tangent at angle θ on a circle is (-sin θ, cos θ),
    // so θ = atan2(-tx, ty).
    const baseAngle = Math.atan2(-tangent.x, tangent.y);

    const clampedEndAngle = Math.max(this.endAngle, -359.9999);
    const cw = clampedEndAngle < 0;
    const startAngleRad = cw ? baseAngle + Math.PI : baseAngle;
    const endAngleRad = startAngleRad + rad(clampedEndAngle);
    const normal = cw ? plane.normal.negate() : plane.normal;

    const startPoint = this.getCurrentPosition();

    const centerPoint = Geometry.getCircleCenter(startPoint, radius, startAngleRad);
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
    this.setCurrentPosition(endPoint);
  }

  compareTo(other: TangentArcWithTangent): boolean {
    if (!(other instanceof TangentArcWithTangent)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.radius === other.radius &&
      this.endAngle === other.endAngle &&
      this.startTangent.compareTo(other.startTangent);
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'tarc-with-tangent';
  }

  serialize() {
    return {
      radius: this.radius,
      endAngle: this.endAngle,
      startTangent: this.startTangent.serialize()
    };
  }
}
