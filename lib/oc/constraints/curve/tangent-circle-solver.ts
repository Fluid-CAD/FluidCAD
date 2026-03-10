import { Geom2dGcc_Circ2d2TanRad } from "occjs-wrapper";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { getQualifiedCurve } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { Geometry } from "../../geometry.js";
import { TangentCircleSolver } from "../constraint-solver.js";

export class CurveTangentCircleSolver implements TangentCircleSolver {
  getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): Edge[] {
    const isVertex1 = shape1.shape instanceof Vertex;
    const isVertex2 = shape2.shape instanceof Vertex;

    if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      return this.getCurvePointTangent(plane, vertex.shape as Vertex, other, radius);
    }

    return this.getCurveCurveTangent(plane, shape1, shape2, radius);
  }

  private getCurveCurveTangent(
    plane: Plane,
    lineShape1: QualifiedShape,
    lineShape2: QualifiedShape,
    radius: number
  ): Edge[] {
    console.log('Getting line-line tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const lineGeometry1 = this.getCurve(lineShape1.shape);
    const lineGeometry2 = this.getCurve(lineShape2.shape);

    const qualifiedLine1 = getQualifiedCurve(pln, lineGeometry1, lineShape1.qualifier);
    const qualifiedLine2 = getQualifiedCurve(pln, lineGeometry2, lineShape2.qualifier);

    const solver = new oc.Geom2dGcc_Circ2d2TanRad(qualifiedLine1, qualifiedLine2, radius, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private getCurvePointTangent(
    plane: Plane,
    vertex: Vertex,
    lineShape: QualifiedShape,
    radius: number
  ): Edge[] {
    console.log('Getting point-line tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    const geom2dPnt = new oc.Geom2d_CartesianPoint(pnt);
    disposePnt();
    const curve = this.getCurve(lineShape.shape);
    const qualifiedCurve = getQualifiedCurve(pln, curve, lineShape.qualifier);

    const solver = new oc.Geom2dGcc_Circ2d2TanRad(qualifiedCurve, geom2dPnt as any, radius, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private collectSolverEdges(solver: Geom2dGcc_Circ2d2TanRad, plane: Plane): Edge[] {
    const oc = getOC();
    const edges: Edge[] = [];

    if (solver.IsDone()) {
      for (let i = 1; i <= solver.NbSolutions(); i++) {
        const circ2d = solver.ThisSolution(i);
        const center2d = Convert.toPoint2D(circ2d.Location());
        const worldCenter = plane.localToWorld(center2d);
        const r = circ2d.Radius();

        const circle = Geometry.makeCircle(worldCenter, r, plane.normal);
        edges.push(Geometry.makeEdgeFromCircle(circle));
      }
    }

    return edges;
  }


  private getCurve(shape: Shape) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());

    const curve = adaptor.Curve();
    const handle = curve.Curve();
    curve.delete();
    adaptor.delete();
    return handle;
  }
}
