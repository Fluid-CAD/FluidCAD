import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";

export type TArcOptions = {};

export class TangentArc extends GeometrySceneObject {

  constructor(
    public radius: number,
    public endAngle: number,
    private options: TArcOptions = null) {
    super();
  }

  build(): void {
    const previousSibling = this.sketch.getPreviousSibling(this);
    if (!previousSibling) {
      throw new Error('TangentArc must have a previous sibling');
    }

    if (!(previousSibling instanceof GeometrySceneObject)) {
      throw new Error('TangentArc previous sibling must be a Curve');
    }

    const tangent = previousSibling.getTangent();

    const plane = this.sketch.getPlane();
    const radius = this.radius;

    // Derive the base angle from the previous sibling's tangent.
    // Tangent at angle θ on a circle is (-sin θ, cos θ),
    // so θ = atan2(-tx, ty).
    const baseAngle = Math.atan2(-tangent.x, tangent.y);

    // For CW (negative endAngle), flip the center to the opposite side
    // and negate the normal so makeArc sweeps in reverse
    // Clamp to avoid coincident start/end points at exactly ±360°
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

    // get tangent vector at the end angle
    // CCW: (-sin θ, cos θ), CW: (sin θ, -cos θ)
    const sign = cw ? -1 : 1;
    const tx = sign * (-Math.sin(endAngleRad));
    const ty = sign * Math.cos(endAngleRad);

    this.setTangent(new Point2D(tx, ty));

    this.addShape(edge);
    this.setCurrentPosition(endPoint);
  }

  compareTo(other: TangentArc): boolean {
    if (!(other instanceof TangentArc)) {
      return false;
    }

    return this.radius === other.radius &&
      this.endAngle === other.endAngle;
  }

  getType(): string {
    return 'tarc';
  }

  serialize() {
    return {
      radius: this.radius,
      endAngle: this.endAngle,
      options: this.options
    }
  }
}
