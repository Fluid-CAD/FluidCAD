import { Geom2dGcc_Circ2d2TanRad, gp_Pnt2d } from "fluidcad-ocjs";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { calculateTangent, filterSolutionsByFiniteExtent, getQualifiedCurve, toArcEdges, toCircleEdges } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { TangentCircleSolver } from "../constraint-solver.js";
import { Point2D } from "../../../math/point.js";

export class CurveTangentCircleSolver implements TangentCircleSolver {
  getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number,
    mustTouch: boolean
  ): Edge[] {
    const isVertex1 = shape1.shape instanceof Vertex;
    const isVertex2 = shape2.shape instanceof Vertex;

    if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      let solutions = this.getCurvePointTangent(plane, vertex.shape as Vertex, other, radius);
      if (mustTouch) {
        solutions = filterSolutionsByFiniteExtent(solutions, shape1.shape, shape2.shape, plane);
      }
      return toCircleEdges(solutions, plane);
    }

    let solutions = this.getCurveCurveTangent(plane, shape1, shape2, radius);
    if (mustTouch) {
      solutions = filterSolutionsByFiniteExtent(solutions, shape1.shape, shape2.shape, plane);
    }
    return toCircleEdges(solutions, plane);
  }

  getTangentArcs(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number,
    mustTouch: boolean
  ): {
    edges: Edge[];
    endTangent: Point2D | null;
  } {
    const isVertex1 = shape1.shape instanceof Vertex;
    const isVertex2 = shape2.shape instanceof Vertex;

    if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      let solutions = this.getCurvePointTangent(plane, vertex.shape as Vertex, other, radius);
      if (mustTouch) {
        solutions = filterSolutionsByFiniteExtent(solutions, shape1.shape, shape2.shape, plane);
      }

      const edges = toArcEdges(solutions, plane);
      const endTangent = calculateTangent(solutions);

      return {
        edges,
        endTangent
      };
    }

    let solutions = this.getCurveCurveTangent(plane, shape1, shape2, radius);
    if (mustTouch) {
      solutions = filterSolutionsByFiniteExtent(solutions, shape1.shape, shape2.shape, plane);
    }

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
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    // Handles are unwrapped in V8: pass the Geom2d_CartesianPoint straight to the
    // solver (constructing the abstract oc.Geom2d_Point base throws at runtime).
    const geom2dPnt = new oc.Geom2d_CartesianPoint(pnt);
    disposePnt();
    const curve = this.getCurve(lineShape.shape);
    const qualifiedCurve = getQualifiedCurve(pln, curve, lineShape.qualifier);

    const solver = new oc.Geom2dGcc_Circ2d2TanRad(qualifiedCurve, geom2dPnt, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);

    disposePln();
    geom2dPnt.delete();

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
    // BRepAdaptor_Curve no longer exposes Curve() in OCCT 8.0. BRep_Tool.Curve
    // returns the underlying Geom_Curve with the edge's location applied (world
    // space) — the same geometry the adaptor chain used to yield — which is what
    // GeomAPI.To2d / the Gcc qualifier expect.
    const edge = oc.TopoDS.Edge(shape.getShape());
    return oc.BRep_Tool.Curve(edge, 0, 1).returnValue;
  }
}
