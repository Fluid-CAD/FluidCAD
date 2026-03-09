import type { GccAna_Lin2d2Tan, GccEnt_QualifiedCirc,  gp_Circ, gp_Lin } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Edge } from "../common/edge.js";
import { ConstraintQualifier, } from "../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../math/plane.js";
import { Geometry } from "./geometry.js";
import { ConstraintResolver } from "./constraint-resolver.js";
import { Vertex } from "../common/vertex.js";
import { Shape } from "../common/shape.js";

export class TangentLineSolver {
  static getTangentLines(
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

      return this.getPointCircleTangent(plane, vertex.shape as Vertex, otherShape);
    }
    else {
      return this.getCircleCircleTangent(plane, shape1, shape2);
    }
  }

  private static getPointCircleTangent(
    plane: Plane,
    vertex: Vertex,
    circleShape: { shape: Shape, qualifier: ConstraintQualifier },
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    const geometry = this.getShapeGeometry(circleShape.shape);
    const qualifiedGeometry = ConstraintResolver.getQualified(pln, geometry, circleShape.qualifier);

    const solver = new oc.GccAna_Lin2d2Tan(qualifiedGeometry as GccEnt_QualifiedCirc, pnt, tolerance);
    disposePnt();

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private static getCircleCircleTangent(
    plane: Plane,
    shape1: { shape: Shape, qualifier: ConstraintQualifier },
    shape2: { shape: Shape, qualifier: ConstraintQualifier },
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const geometry1 = this.getShapeGeometry(shape1.shape);
    const geometry2 = this.getShapeGeometry(shape2.shape);
    const qualifiedGeometry1 = ConstraintResolver.getQualified(pln, geometry1, shape1.qualifier);
    const qualifiedGeometry2 = ConstraintResolver.getQualified(pln, geometry2, shape2.qualifier);

    const solver = new oc.GccAna_Lin2d2Tan(qualifiedGeometry1 as GccEnt_QualifiedCirc, qualifiedGeometry2 as GccEnt_QualifiedCirc, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private static collectSolverEdges(solver: GccAna_Lin2d2Tan, plane: Plane): Edge[] {
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

  private static getShapeGeometry(shape: Shape) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType();
    let geometry: gp_Circ | gp_Lin;

    if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {

      geometry = adaptor.Line()
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle && adaptor.IsClosed()) {
       geometry = adaptor.Circle();
    }
    else {
      adaptor.delete();
      throw new Error('Unsupported shape type for tangent line solver');
    }

    adaptor.delete();
    return geometry;
  }
}
