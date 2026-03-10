import { Edge } from "../../common/edge.js";
import { QualifiedShape } from "../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../math/plane.js";

export interface TangentLineSolver {
  getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
  ): Edge[];
}

export abstract class ConstraintSolver implements TangentLineSolver {
  abstract getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
  ): Edge[];
}

