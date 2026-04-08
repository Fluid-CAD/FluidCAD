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
    if (this.controlPoints.length === 0) {
      return;
    }

    const plane = this.sketch.getPlane();
    const currentPos = this.getCurrentPosition();
    const points = this.controlPoints.map(cp => cp.asPoint2D());

    // Poles: [currentPos (start), ...controlPoints, endPoint]
    // All args are in order: control points then endpoint (last arg)
    const poles2D = [currentPos, ...points];
    const polesWorld = poles2D.map(p => plane.localToWorld(p));

    const bezierCurve = Geometry.makeBezierCurve(polesWorld);

    // Compute tangent at endpoint before creating the edge
    const oc = getOC();
    const gpP = new oc.gp_Pnt(0, 0, 0);
    const gpV = new oc.gp_Vec(0, 0, 0);
    bezierCurve.D1(bezierCurve.LastParameter(), gpP, gpV);
    const tangentWorld = Convert.toVector3d(gpV, true);
    gpP.delete();

    // Project tangent to 2D sketch coordinates
    const tangent2D = new Point2D(
      tangentWorld.dot(plane.xDirection),
      tangentWorld.dot(plane.yDirection),
    ).normalize();

    const edge = Geometry.makeEdgeFromBezier(bezierCurve);

    const endPoint = points[points.length - 1];
    this.setState('start', Vertex.fromPoint2D(currentPos));
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
    const startPos = this.getCurrentPosition();
    const resolved = this.controlPoints.map(cp => {
      const p = cp.asPoint2D();
      return [p.x, p.y];
    });
    return {
      controlPoints: this.controlPoints,
      startPoint: [startPos.x, startPos.y],
      resolvedPoints: resolved,
    };
  }
}
