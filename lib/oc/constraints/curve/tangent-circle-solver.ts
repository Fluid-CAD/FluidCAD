import { Geom2dGcc_Circ2d2TanRad, gp_Pnt2d } from "occjs-wrapper";
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
      return this.toCircleEdges(solutions, plane);
    }

    const solutions = this.getCurveCurveTangent(plane, shape1, shape2, radius);
    return this.toCircleEdges(solutions, plane);
  }

  getTangentArcs(
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
      return this.toArcEdges(solutions, plane);
    }

    const solutions = this.getCurveCurveTangent(plane, shape1, shape2, radius);
    return this.toArcEdges(solutions, plane);
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
    disposePnt();
    const curve = this.getCurve(lineShape.shape);
    const qualifiedCurve = getQualifiedCurve(pln, curve, lineShape.qualifier);

    const solver = new oc.Geom2dGcc_Circ2d2TanRad(qualifiedCurve, geom2dPnt as any, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);
    disposePln();
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

  private toCircleEdges(solutions: {
    center: gp_Pnt2d;
    radius: number;
    tangentPoint1: gp_Pnt2d;
    tangentPoint2: gp_Pnt2d;
  }[], plane: Plane): Edge[] {
    return solutions.map(solution => {
      const center2d = Convert.toPoint2D(solution.center);
      const worldCenter = plane.localToWorld(center2d);
      const circle = Geometry.makeCircle(worldCenter, solution.radius, plane.normal);
      return Geometry.makeEdgeFromCircle(circle);
    });
  }

  private toArcEdges(solutions: {
    center: gp_Pnt2d;
    radius: number;
    tangentPoint1: gp_Pnt2d;
    tangentPoint2: gp_Pnt2d;
  }[], plane: Plane): Edge[] {
    const oc = getOC();
    return solutions.map(solution => {
      const pnt1 = Convert.toPoint2D(solution.tangentPoint1, true);
      const pnt2 = Convert.toPoint2D(solution.tangentPoint2, true);
      const center = Convert.toPoint2D(solution.center, true);
      const radius = solution.radius;

      const worldPnt1 = plane.localToWorld(pnt1);
      const worldPnt2 = plane.localToWorld(pnt2);

      const angle1 = Math.atan2(pnt1.y - center.y, pnt1.x - center.x);
      const angle2 = Math.atan2(pnt2.y - center.y, pnt2.x - center.x);

      let diff = angle2 - angle1;
      if (diff > Math.PI) { diff -= 2 * Math.PI; }
      if (diff < -Math.PI) { diff += 2 * Math.PI; }

      const midAngle = angle1 + diff / 2;
      const worldMid = plane.localToWorld(new Point2D(
        center.x + radius * Math.cos(midAngle),
        center.y + radius * Math.sin(midAngle)
      ));

      const arc = Geometry.makeArcThreePoints(worldPnt1, worldMid, worldPnt2);
      return Geometry.makeEdgeFromCurve(arc);
    });
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
