import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { ConstraintSolver } from "../constraint-solver.js";
import { CurveTangentLineSolver } from "./tangent-line-solver.js";

export class CurveConstraintSolver extends ConstraintSolver {
  getTangentCircles(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number): Edge[] {
      throw new Error("Method not implemented.");
  }

  getTangentLines(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape): Edge[] {
    const solver = new CurveTangentLineSolver();
    return solver.getTangentLines(plane, shape1, shape2);
  }
}

