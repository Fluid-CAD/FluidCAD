import { GccAna_Lin2d2Tan, GccEnt_QualifiedCirc, gp_Circ, gp_Lin } from "occjs-wrapper";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { ConstraintQualifier } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { getQualifiedCurve } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { Geometry } from "../../geometry.js";
import { TangentLineSolver } from "../constraint-solver.js";

export class CurveTangentLineSolver implements TangentLineSolver {
  getTangentLines(
    plane: Plane,
    shape1: { shape: Shape, qualifier: ConstraintQualifier },
    shape2: { shape: Shape, qualifier: ConstraintQualifier },
  ): Edge[] {
    if (shape1.shape instanceof Vertex || shape2.shape instanceof Vertex) {
      const [vertex] = [shape1, shape2].filter(s => s.shape instanceof Vertex);
      const [otherShape] = [shape1, shape2].filter(s => s !== vertex);

      if (otherShape instanceof Vertex) {
        // todo: create a line between the two points and return it as the single tangent solution
        return [];
      }

      return this.getPointCurveTangent(plane, vertex.shape as Vertex, otherShape);
    }
    else {
      return this.getCurveCurveTangent(plane, shape1, shape2);
    }
  }

  private getPointCurveTangent(
    plane: Plane,
    vertex: Vertex,
    circleShape: { shape: Shape, qualifier: ConstraintQualifier },
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());

    const curve = this.getCurve(circleShape.shape);
    const qualifiedGeometry = getQualifiedCurve(pln, curve, circleShape.qualifier);

    const solver = new oc.Geom2dGcc_Lin2d2Tan(qualifiedGeometry, pnt, tolerance);
    disposePnt();

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private getCurveCurveTangent(
    plane: Plane,
    shape1: { shape: Shape, qualifier: ConstraintQualifier },
    shape2: { shape: Shape, qualifier: ConstraintQualifier },
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const curve1 = this.getCurve(shape1.shape);
    const curve2 = this.getCurve(shape2.shape);
    const qualifiedGeometry1 = getQualifiedCurve(pln, curve1, shape1.qualifier);
    const qualifiedGeometry2 = getQualifiedCurve(pln, curve2, shape2.qualifier);

    const solver = new oc.Geom2dGcc_Lin2d2Tan(qualifiedGeometry1, qualifiedGeometry2, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }
  private collectSolverEdges(solver: GccAna_Lin2d2Tan, plane: Plane): Edge[] {
    const oc = getOC();
    const edges: Edge[] = [];

    if (solver.IsDone()) {
      const nSolutions = solver.NbSolutions();

      for (let i = 1; i <= nSolutions; i++) {
        const pnt1 = new oc.gp_Pnt2d();
        const pnt2 = new oc.gp_Pnt2d();
        solver.Tangency1(i, 0, 0, pnt1);
        solver.Tangency2(i, 0, 0, pnt2);

        const worldPnt1 = plane.localToWorld(Convert.toPoint2D(pnt1, true));
        const worldPnt2 = plane.localToWorld(Convert.toPoint2D(pnt2, true));

        const line = Geometry.makeSegment(worldPnt1, worldPnt2);
        edges.push(Geometry.makeEdge(line));
      }
    }

    return edges;
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
