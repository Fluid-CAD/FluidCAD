import { ConstraintSolver } from "./constraint-solver.js";
import { QualifiedShape } from "../../features/2d/constraints/qualified-geometry.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Shape } from "../../common/shape.js";
import { getOC } from "../init.js";
import { GeometricConstraintSolver } from "./geometric/geometric-constraint-solver.js";
import { CurveConstraintSolver } from "./curve/curve-constraint-solver.js";
import { Vertex } from "../../common/vertex.js";

export class ConstraintSolverAdaptor extends ConstraintSolver {
  constructor(private geometricSolver: GeometricConstraintSolver, private curveSolver: CurveConstraintSolver) {
    super();
  }

  getTangentLines(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
  ): Edge[] {
    const types: string[] = [];
    if (!(shape1.shape instanceof Vertex)) {
      const type1 = this.getShapeGeometry(shape1.shape);
      types.push(type1);
    }

    if (!(shape2.shape instanceof Vertex)) {
      const type2 = this.getShapeGeometry(shape2.shape);
      types.push(type2);
    }

    console.log('Shape types for tangent line solver:', types);

    if (types.some(type => type === 'curve')) {
      return this.curveSolver.getTangentLines(plane, shape1, shape2);
    }

    return this.geometricSolver.getTangentLines(plane, shape1, shape2);
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
        return 'circle';
      }

      adaptor.delete();
      return 'curve';
    }

    adaptor.delete();
    throw new Error('Unsupported shape type for tangent line solver');
  }
}
