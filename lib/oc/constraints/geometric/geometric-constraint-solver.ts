import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { Point2D } from "../../../math/point.js";
import { ConstraintSolver } from "../constraint-solver.js";
import { GeometricTangentCircleSolver } from "./tangent-circle-solver.js";
import { GeometricTangentLineSolver } from "./tangent-line-solver.js";
import { solveTangentArcFromPointTangent } from "./tangent-arc-from-point-tangent.js";

export class GeometricConstraintSolver extends ConstraintSolver {
  getTangentLines(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, mustTouch: boolean): Edge[] {
    const tangentLineSolver = new GeometricTangentLineSolver();
    return tangentLineSolver.getTangentLines(plane, shape1, shape2, mustTouch);
  }

  getTangentCircles(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number, mustTouch: boolean): Edge[] {
    const tangentCircleSolver = new GeometricTangentCircleSolver();
    return tangentCircleSolver.getTangentCircles(plane, shape1, shape2, radius, mustTouch);
  }

  getTangentArcs(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number, mustTouch: boolean) {
    const solver = new GeometricTangentCircleSolver();
    return solver.getTangentArcs(plane, shape1, shape2, radius, mustTouch);
  }

  getTangentArcFromPointTangent(
    plane: Plane,
    startPoint: Point2D,
    startTangent: Point2D,
    target: QualifiedShape,
    flip: boolean
  ) {
    return solveTangentArcFromPointTangent(plane, startPoint, startTangent, target, flip);
  }
}
