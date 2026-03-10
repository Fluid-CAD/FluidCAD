import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { ConstraintSolver } from "../constraint-solver.js";

export class CurveConstraintSolver extends ConstraintSolver {
  getTangentLines(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape): Edge[] {
    throw new Error("Method not implemented.");
  }
}

