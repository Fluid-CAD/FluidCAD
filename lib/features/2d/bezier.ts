import { Geometry } from "../../oc/geometry.js";
import { Point, Point2D } from "../../math/point.js";
import type { Edge } from "../../common/edge.js";
import type { LazyVertex } from "../lazy-vertex.js";
import { ControlPointCurve, type ControlPointSource } from "./control-point-curve.js";

export type { ControlPointSource };

/**
 * A bezier statement: its points are the curve's poles — the first and
 * last on the curve, the ones between pulling it (degree = points − 1).
 * Solver participation (anchor points, accessors, payload) is the shared
 * {@link ControlPointCurve} rail.
 */
export class BezierCurve extends ControlPointCurve {

  protected buildEdge(points: Point2D[]): Edge {
    // Poles: all args in order — first is start, last is endpoint, middle are controls.
    const plane = this.sketch.getPlane();
    const polesWorld: Point[] = points.map(p => plane.localToWorld(p));
    const bezierCurve = Geometry.makeBezierCurve(polesWorld);
    return Geometry.makeEdgeFromBezier(bezierCurve);
  }

  protected newInstance(controlPoints: LazyVertex[], literalIndices: number[]): ControlPointCurve {
    return new BezierCurve(controlPoints, literalIndices);
  }

  getType(): string {
    return 'bezier';
  }
}
