import { GccAna_Lin2d2Tan, GccEnt_QualifiedCirc, Geom2dGcc_Lin2d2Tan, gp_Circ, gp_Lin, gp_Pnt2d } from "occjs-wrapper";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { ConstraintQualifier } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { filterSolutionsByFiniteExtent, getQualifiedCurve } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { Geometry } from "../../geometry.js";
import { TangentLineSolver } from "../constraint-solver.js";

export class CurveTangentLineSolver implements TangentLineSolver {
  getTangentLines(
    plane: Plane,
    shape1: { shape: Shape, qualifier: ConstraintQualifier },
    shape2: { shape: Shape, qualifier: ConstraintQualifier },
    mustTouch: boolean
  ): Edge[] {
    let solutions: { tangentPoint1: gp_Pnt2d; tangentPoint2: gp_Pnt2d }[];

    if (shape1.shape instanceof Vertex || shape2.shape instanceof Vertex) {
      const [vertex] = [shape1, shape2].filter(s => s.shape instanceof Vertex);
      const [otherShape] = [shape1, shape2].filter(s => s !== vertex);

      if (otherShape instanceof Vertex) {
        // todo: create a line between the two points and return it as the single tangent solution
        return [];
      }

      solutions = this.getPointCurveTangent(plane, vertex.shape as Vertex, otherShape);
    } else {
      solutions = this.getCurveCurveTangent(plane, shape1, shape2);
    }

    if (mustTouch) {
      solutions = filterSolutionsByFiniteExtent(solutions, shape1.shape, shape2.shape, plane);
    }

    return this.solutionsToEdges(solutions, plane);
  }

  private getPointCurveTangent(
    plane: Plane,
    vertex: Vertex,
    circleShape: { shape: Shape, qualifier: ConstraintQualifier },
  ) {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());

    const curve = this.getCurve(circleShape.shape);
    const qualifiedGeometry = getQualifiedCurve(pln, curve, circleShape.qualifier);

    const solver = new oc.Geom2dGcc_Lin2d2Tan(qualifiedGeometry, pnt, tolerance);
    disposePnt();

    const solutions = this.getSolutions(solver);
    disposePln();
    return solutions;
  }

  private getCurveCurveTangent(
    plane: Plane,
    shape1: { shape: Shape, qualifier: ConstraintQualifier },
    shape2: { shape: Shape, qualifier: ConstraintQualifier },
  ) {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const curve1 = this.getCurve(shape1.shape);
    const curve2 = this.getCurve(shape2.shape);
    const qualifiedGeometry1 = getQualifiedCurve(pln, curve1, shape1.qualifier);
    const qualifiedGeometry2 = getQualifiedCurve(pln, curve2, shape2.qualifier);

    const solver = new oc.Geom2dGcc_Lin2d2Tan(qualifiedGeometry1, qualifiedGeometry2, tolerance);

    const solutions = this.getSolutions(solver);
    disposePln();
    return solutions;
  }

  private getSolutions(solver: Geom2dGcc_Lin2d2Tan) {
    const oc = getOC();
    const solutions: { tangentPoint1: gp_Pnt2d; tangentPoint2: gp_Pnt2d }[] = [];

    if (solver.IsDone()) {
      for (let i = 1; i <= solver.NbSolutions(); i++) {
        const pnt1 = new oc.gp_Pnt2d();
        const pnt2 = new oc.gp_Pnt2d();
        solver.Tangency1(i, 0, 0, pnt1);
        solver.Tangency2(i, 0, 0, pnt2);

        solutions.push({ tangentPoint1: pnt1, tangentPoint2: pnt2 });
      }
    }

    return solutions;
  }

  private solutionsToEdges(solutions: { tangentPoint1: gp_Pnt2d; tangentPoint2: gp_Pnt2d }[], plane: Plane): Edge[] {
    return solutions.map(solution => {
      const worldPnt1 = plane.localToWorld(Convert.toPoint2D(solution.tangentPoint1, true));
      const worldPnt2 = plane.localToWorld(Convert.toPoint2D(solution.tangentPoint2, true));

      const line = Geometry.makeSegment(worldPnt1, worldPnt2);
      return Geometry.makeEdge(line);
    });
  }

  private getCurve(shape: Shape) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());

    const curve  = adaptor.Curve();
    const handle = curve.Curve();
    curve.delete();
    adaptor.delete();
    return handle;
  }
}
