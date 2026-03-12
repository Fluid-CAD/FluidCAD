import { Geom2dGcc_Circ2d2TanRad, gp_Pnt2d } from "occjs-wrapper";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { calculateTangent, getQualifiedCurve, toArcEdges, toCircleEdges } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { Geometry } from "../../geometry.js";
import { TangentCircleSolver } from "../constraint-solver.js";
import { Point, Point2D } from "../../../math/point.js";

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
      const solutions = this.getCurvePointTangent(plane, vertex.shape as Vertex, other, radius);
      return toCircleEdges(solutions, plane);
    }

    const solutions = this.getCurveCurveTangent(plane, shape1, shape2, radius);
    return toCircleEdges(solutions, plane);
  }

  getTangentArcs(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): {
    edges: Edge[];
    endTangent: Point2D | null;
  } {
    const isVertex1 = shape1.shape instanceof Vertex;
    const isVertex2 = shape2.shape instanceof Vertex;

    if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      const solutions = this.getCurvePointTangent(plane, vertex.shape as Vertex, other, radius);

      const edges = toArcEdges(solutions, plane);
      const endTangent = calculateTangent(solutions);

      return {
        edges,
        endTangent
      };
    }

    const solutions = this.getCurveCurveTangent(plane, shape1, shape2, radius);

    const edges = toArcEdges(solutions, plane);
    const endTangent = calculateTangent(solutions);

    return {
      edges,
      endTangent
    };
  }

  private getCurveCurveTangent(
    plane: Plane,
    lineShape1: QualifiedShape,
    lineShape2: QualifiedShape,
    radius: number
  ) {
    console.log('Getting curve-curve tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const curve1 = this.getCurve(lineShape1.shape);
    const curve2 = this.getCurve(lineShape2.shape);

    const qualifiedCurve1 = getQualifiedCurve(pln, curve1, lineShape1.qualifier);
    const qualifiedCurve2 = getQualifiedCurve(pln, curve2, lineShape2.qualifier);

    const solver = new oc.Geom2dGcc_Circ2d2TanRad(qualifiedCurve1, qualifiedCurve2, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);
    disposePln();
    return solutions;
  }

  private getCurvePointTangent(
    plane: Plane,
    vertex: Vertex,
    lineShape: QualifiedShape,
    radius: number
  ) {
    console.log('Getting point-line tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    const geom2dPnt = new oc.Geom2d_CartesianPoint(pnt);
    const handle = new oc.Handle_Geom2d_Point(geom2dPnt);
    disposePnt();
    const curve = this.getCurve(lineShape.shape);
    const qualifiedCurve = getQualifiedCurve(pln, curve, lineShape.qualifier);

    const solver = new oc.Geom2dGcc_Circ2d2TanRad(qualifiedCurve, handle, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);

    disposePln();
    handle.delete();

    return solutions;
  }

  private getSolutions(solver: Geom2dGcc_Circ2d2TanRad, plane: Plane) {
    const oc = getOC();
    const result: {
      center: gp_Pnt2d;
      radius: number;
      tangentPoint1: gp_Pnt2d;
      tangentPoint2: gp_Pnt2d;
    }[] = [];

    if (solver.IsDone()) {
      for (let i = 1; i <= solver.NbSolutions(); i++) {
        const circ2d = solver.ThisSolution(i);
        const radius = circ2d.Radius();
        const center = circ2d.Location();

        const pnt1 = new oc.gp_Pnt2d();
        const pnt2 = new oc.gp_Pnt2d();

        solver.Tangency1(i, 0, 0, pnt1);
        solver.Tangency2(i, 0, 0, pnt2);

        result.push({
          center,
          radius,
          tangentPoint1: pnt1,
          tangentPoint2: pnt2
        });
      }
    }

    return result;
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
