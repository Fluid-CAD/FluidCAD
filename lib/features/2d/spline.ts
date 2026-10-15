import { Geometry } from "../../oc/geometry.js";
import { Point, Point2D } from "../../math/point.js";
import { interpolateBSpline2d } from "../../math/bspline-interpolation.js";
import type { Edge } from "../../common/edge.js";
import { ControlPointCurve } from "./control-point-curve.js";

/**
 * A spline statement: a smooth curve THROUGH its points (fit points), not
 * pulled by them like a bezier's poles — the sketcher's free-form curve
 * for traced outlines, cams and anything a bezier's handles would be too
 * indirect for. The curve is a cubic B-spline (lower with 2 or 3 points),
 * chord-length parameterized, C2 everywhere; moving one point reshapes the
 * curve locally. Solver participation (anchor points, accessors, payload)
 * is the shared {@link ControlPointCurve} rail.
 */
export class SplineCurve extends ControlPointCurve {

  protected buildEdge(points: Point2D[]): Edge {
    // Interpolate in sketch space — the UI tessellates the same data the
    // same way — then carry the poles to world space: the plane map is
    // affine, so the world curve is the mapped sketch curve exactly. The
    // chord-length parameters agree too (the map is an isometry).
    const data = interpolateBSpline2d(points.map(p => ({ x: p.x, y: p.y })));
    const plane = this.sketch.getPlane();
    const poles = data.poles.map(pole => {
      const world: Point = plane.localToWorld(new Point2D(pole.x, pole.y));
      return [world.x, world.y, world.z];
    });
    return Geometry.makeEdgeFromBSplineData({
      poles,
      knots: data.knots,
      multiplicities: data.multiplicities,
      degree: data.degree,
    });
  }

  getType(): string {
    return 'spline';
  }
}
