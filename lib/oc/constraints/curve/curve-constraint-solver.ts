import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { ConstraintSolver } from "../constraint-solver.js";
import { CurveTangentCircleSolver } from "./tangent-circle-solver.js";
import { CurveTangentLineSolver } from "./tangent-line-solver.js";

export class CurveConstraintSolver extends ConstraintSolver {
  getTangentCircles(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number): Edge[] {
    const solver = new CurveTangentCircleSolver();
    console.log('Getting tangent circles');
    return solver.getTangentCircles(plane, shape1, shape2, radius);
  }

  getTangentLines(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape): Edge[] {
    const solver = new CurveTangentLineSolver();
    return solver.getTangentLines(plane, shape1, shape2);
  }

  getTangentArcs(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number): Edge[] {
    const solver = new CurveTangentCircleSolver();
    return solver.getTangentArcs(plane, shape1, shape2, radius);
  }
}

