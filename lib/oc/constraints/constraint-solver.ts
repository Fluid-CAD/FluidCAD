import { Edge } from "../../common/edge.js";
import { QualifiedShape } from "../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../math/plane.js";
import { Point2D } from "../../math/point.js";

export interface TangentLineSolver {
  getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    mustTouch?: boolean
  ): Edge[];
}

export interface TangentCircleSolver {
  getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number,
    mustTouch?: boolean
  ): Edge[];
}

export abstract class ConstraintSolver implements TangentLineSolver, TangentCircleSolver {
  abstract getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    mustTouch?: boolean
  ): Edge[];

  abstract getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number,
    mustTouch?: boolean
  ): Edge[];

  abstract getTangentArcs(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number,
    mustTouch?: boolean
  ): {
    edges: Edge[];
    endTangent: Point2D
  };
}
