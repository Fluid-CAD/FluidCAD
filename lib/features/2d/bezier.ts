import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { Convert } from "../../oc/convert.js";
import { getOC } from "../../oc/init.js";
import { Point2D } from "../../math/point.js";
import { LazyVertex } from "../lazy-vertex.js";
import { GeometrySceneObject } from "./geometry.js";

export class BezierCurve extends GeometrySceneObject {

  constructor(public controlPoints: LazyVertex[]) {
    super();
  }

  build(): void {
    const points = this.controlPoints.map(cp => cp.asPoint2D());
    if (points.length < 2) {
      // 0 args: interactive placeholder. 1 arg: start placed, no curve yet.
      if (points.length === 1) {
        this.setState('start', Vertex.fromPoint2D(points[0]));
        this.setCurrentPosition(points[0]);
      }
      return;
    }

    const plane = this.sketch.getPlane();
    const startPoint = points[0];
    const endPoint = points[points.length - 1];

    // Poles: all args in order — first is start, last is endpoint, middle are controls.
    const polesWorld = points.map(p => plane.localToWorld(p));

    const bezierCurve = Geometry.makeBezierCurve(polesWorld);

    // Compute tangent at endpoint before creating the edge
    const oc = getOC();
    const gpP = new oc.gp_Pnt(0, 0, 0);
    const gpV = new oc.gp_Vec(0, 0, 0);
    bezierCurve.D1(bezierCurve.LastParameter(), gpP, gpV);
    const tangentWorld = Convert.toVector3d(gpV, true);
    gpP.delete();

    const tangent2D = new Point2D(
      tangentWorld.dot(plane.xDirection),
      tangentWorld.dot(plane.yDirection),
    ).normalize();

    const edge = Geometry.makeEdgeFromBezier(bezierCurve);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));
    this.addShape(edge);
    this.setTangent(tangent2D);
    this.setCurrentPosition(endPoint);
  }

  compareTo(other: BezierCurve): boolean {
    if (!(other instanceof BezierCurve)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.controlPoints.length !== other.controlPoints.length) {
      return false;
    }

    for (let i = 0; i < this.controlPoints.length; i++) {
      if (!this.controlPoints[i].compareTo(other.controlPoints[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'bezier';
  }

  getUniqueType(): string {
    return `bezier-${this.controlPoints.length}`;
  }

  serialize() {
    const points = this.controlPoints.map(cp => cp.asPoint2D());
    const start = points[0];
    const resolved = points.slice(1).map(p => [p.x, p.y]);
    return {
      controlPoints: this.controlPoints,
      startPoint: start ? [start.x, start.y] : null,
      resolvedPoints: resolved,
    };
  }
}
