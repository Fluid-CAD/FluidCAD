import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { ConstraintSolver } from "../constraint-solver.js";
import { GeometricTangentLineSolver } from "./tangent-line-solver.js";

export class GeometricConstraintSolver extends ConstraintSolver {
  getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
  ): Edge[] {
    console.log('GeometricConstraintSolver: Solving tangent lines for shapes', shape1.shape, shape2.shape);
    const tangentLineSolver = new GeometricTangentLineSolver();
    return tangentLineSolver.getTangentLines(plane, shape1, shape2);
  }

}
