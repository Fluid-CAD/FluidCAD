import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";

export class ArcThreePoints extends GeometrySceneObject {
  constructor(
    public startPoint: LazyVertex,
    public endPoint: LazyVertex,
    public center: LazyVertex,
    private targetPlane: PlaneObjectBase = null
  ) {
    super();
  }

  build(): void {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const startPt = this.startPoint.asPoint2D();
    const endPt = this.endPoint.asPoint2D();
    const centerPt = this.center.asPoint2D();

    const dx = startPt.x - centerPt.x;
    const dy = startPt.y - centerPt.y;
    const radius = Math.sqrt(dx * dx + dy * dy);

    const endAngle = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);

    const center = plane.localToWorld(centerPt);
    const start = plane.localToWorld(startPt);
    const end = plane.localToWorld(endPt);

    const arc = Geometry.makeArc(center, radius, plane.normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    // Tangent at end: perpendicular to radius direction at end point (CCW)
    const tx = -Math.sin(endAngle);
    const ty = Math.cos(endAngle);
    this.setTangent(new Point2D(tx, ty));

    this.setState('start', Vertex.fromPoint2D(startPt));
    this.setState('end', Vertex.fromPoint2D(endPt));
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(endPt);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  compareTo(other: ArcThreePoints): boolean {
    if (!(other instanceof ArcThreePoints)) {
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
    return this.startPoint.compareTo(other.startPoint) &&
      this.endPoint.compareTo(other.endPoint) &&
      this.center.compareTo(other.center);
  }

  getType(): string {
    return 'arc';
  }

  getUniqueType(): string {
    return 'arc-three-points';
  }

  serialize() {
    return {
      startPoint: this.startPoint.serialize(),
      endPoint: this.endPoint.serialize(),
      center: this.center.serialize()
    };
  }
}
