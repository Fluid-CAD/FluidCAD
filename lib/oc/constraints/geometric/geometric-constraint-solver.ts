import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { ConstraintSolver } from "../constraint-solver.js";
import { GeometricTangentCircleSolver } from "./tangent-circle-solver.js";
import { GeometricTangentLineSolver } from "./tangent-line-solver.js";

export class GeometricConstraintSolver extends ConstraintSolver {
  getTangentLines(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape): Edge[] {
    const tangentLineSolver = new GeometricTangentLineSolver();
    return tangentLineSolver.getTangentLines(plane, shape1, shape2);
  }

  getTangentCircles(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number): Edge[] {
    const tangentCircleSolver = new GeometricTangentCircleSolver();
    return tangentCircleSolver.getTangentCircles(plane, shape1, shape2, radius);
  }

  getTangentArcs(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number) {
    const solver = new GeometricTangentCircleSolver();
    return solver.getTangentArcs(plane, shape1, shape2, radius);
  }
}
