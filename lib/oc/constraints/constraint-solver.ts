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

export interface TangentCircleSolver {
  getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): Edge[];
}

export abstract class ConstraintSolver implements TangentLineSolver, TangentCircleSolver {
  abstract getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
  ): Edge[];

  abstract getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): Edge[];

  abstract getTangentArcs(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): Edge[];
}

