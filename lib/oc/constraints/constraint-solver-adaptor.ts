import { ConstraintSolver } from "./constraint-solver.js";
import { QualifiedShape } from "../../features/2d/constraints/qualified-geometry.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Shape } from "../../common/shape.js";
import { getOC } from "../init.js";
import { GeometricConstraintSolver } from "./geometric/geometric-constraint-solver.js";
import { CurveConstraintSolver } from "./curve/curve-constraint-solver.js";
import { Vertex } from "../../common/vertex.js";
import { Point2D } from "../../math/point.js";

export class ConstraintSolverAdaptor extends ConstraintSolver {
  constructor(private geometricSolver: GeometricConstraintSolver, private curveSolver: CurveConstraintSolver) {
    super();
  }

  getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
  ): Edge[] {
    console.log('Determining which solver to use for tangent lines', shape1, shape2);
    if (this.isCurve(shape1.shape) || this.isCurve(shape2.shape)) {
      console.log('Using curve solver for tangent shapes');
      return this.curveSolver.getTangentLines(plane, shape1, shape2);
    }

    console.log('Using geometric solver for tangent shapes');
    return this.geometricSolver.getTangentLines(plane, shape1, shape2);
  }

  getTangentCircles(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number): Edge[] {
    if (this.isCurve(shape1.shape) || this.isCurve(shape2.shape)) {
      console.log('Using curve solver for tangent circles');
      return this.curveSolver.getTangentCircles(plane, shape1, shape2, radius);
    }

    console.log('Using geometric solver for tangent circles');
    return this.geometricSolver.getTangentCircles(plane, shape1, shape2, radius);
  }

  getTangentArcs(plane: Plane, shape1: QualifiedShape, shape2: QualifiedShape, radius: number) {
    if (this.isCurve(shape1.shape) || this.isCurve(shape2.shape)) {
      console.log('Using curve solver for tangent arcs');
      return this.curveSolver.getTangentArcs(plane, shape1, shape2, radius);
    }

    console.log('Using geometric solver for tangent circles');
    return this.geometricSolver.getTangentArcs(plane, shape1, shape2, radius);
  }

  isCurve(shape: Shape): boolean {
    return !(shape instanceof Vertex) && this.getShapeGeometry(shape) === 'curve';
  }

  private getShapeGeometry(shape: Shape) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType();

    if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      adaptor.delete();
      return 'line';
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      if (adaptor.IsClosed()) {
        console.log('Shape is a closed circle');
        adaptor.delete();
        return 'circle';
      }

      adaptor.delete();
      return 'curve';
    }

    adaptor.delete();
    throw new Error('Unsupported shape type for tangent line solver');
  }
}
