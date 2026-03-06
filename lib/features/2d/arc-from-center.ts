import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D } from "../../math/point.js";
import { LazyVertex } from "../lazy-vertex.js";
import { GeometrySceneObject } from "./geometry.js";

export class ArcFromCenterAndAngle extends GeometrySceneObject {
  constructor(
    public center: LazyVertex,
    public angle: number,
    public centered: boolean = false
  ) {
    super();
  }

  build(): void {
    const plane = this.sketch.getPlane();
    const currentPos = this.getCurrentPosition();
    const centerPoint = this.center.asPoint2D();

    const dx = currentPos.x - centerPoint.x;
    const dy = currentPos.y - centerPoint.y;
    const radius = Math.sqrt(dx * dx + dy * dy);
    const midAngleRad = Math.atan2(dy, dx);

    const cw = this.angle < 0;
    const halfSweep = rad(this.angle) / 2;
    const startAngleRad = this.centered ? midAngleRad - halfSweep : midAngleRad;
    const endAngleRad = this.centered ? midAngleRad + halfSweep : midAngleRad + rad(this.angle);
    const normal = cw ? plane.normal.negate() : plane.normal;

    const startPoint = this.centered
      ? Geometry.getPointOnCircle(centerPoint, radius, startAngleRad)
      : currentPos;

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

  compareTo(other: ArcFromCenterAndAngle): boolean {
    if (!(other instanceof ArcFromCenterAndAngle)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.center.compareTo(other.center) &&
      this.angle === other.angle &&
      this.centered === other.centered;
  }

  getType(): string {
    return 'arc-from-center';
  }

  serialize() {
    return {
      center: this.center.serialize(),
      angle: this.angle,
      centered: this.centered
    };
  }
}
