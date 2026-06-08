import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { Point2D } from "../../../math/point.js";
import { ConstraintSolver } from "../constraint-solver.js";
import { CurveTangentCircleSolver } from "./tangent-circle-solver.js";
import { CurveTangentLineSolver } from "./tangent-line-solver.js";

export class CurveConstraintSolver extends ConstraintSolver {
  getTangentCircles(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number, mustTouch: boolean): Edge[] {
    const solver = new CurveTangentCircleSolver();
    console.log('Getting tangent circles');
    return solver.getTangentCircles(plane, shape1, shape2, radius, mustTouch);
  }

  getTangentLines(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, mustTouch: boolean): Edge[] {
    const solver = new CurveTangentLineSolver();
    return solver.getTangentLines(plane, shape1, shape2, mustTouch);
  }

  getTangentArcs(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number, mustTouch: boolean) {
    const solver = new CurveTangentCircleSolver();
    return solver.getTangentArcs(plane, shape1, shape2, radius, mustTouch);
  }

  getTangentArcFromPointTangent(
    _plane: Plane,
    _startPoint: Point2D,
    _startTangent: Point2D,
    _target: QualifiedShape,
    _flip: boolean
  ): { edges: Edge[]; endTangent: Point2D | null } {
    throw new Error('tArc(target): only line targets are supported');
  }
}
