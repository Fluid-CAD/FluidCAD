import { GccAna_Circ2d2TanRad, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, gp_Circ, gp_Lin, gp_Pnt2d } from "occjs-wrapper";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { calculateTangent, getQualifiedGeometry, toArcEdges, toCircleEdges } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { TangentCircleSolver } from "../constraint-solver.js";
import { Point2D } from "../../../math/point.js";

export class GeometricTangentCircleSolver implements TangentCircleSolver {
  getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ) {
    const isVertex1 = shape1.shape instanceof Vertex;
    const isVertex2 = shape2.shape instanceof Vertex;
    let solutions: {
      center: gp_Pnt2d;
      radius: number;
      tangentPoint1: gp_Pnt2d;
      tangentPoint2: gp_Pnt2d;
    }[];

    if (isVertex1 && isVertex2) {
      solutions = this.getPointPointCircleTangent(plane, shape1.shape as Vertex, shape2.shape as Vertex, radius);
    }
    else if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      if (this.isLine(other.shape)) {
        solutions = this.getPointLineTangent(plane, vertex.shape as Vertex, other, radius);
      }
      else {
        solutions = this.getPointCircleTangent(plane, vertex.shape as Vertex, other, radius);
      }
    }
    else {
      const isLine1 = this.isLine(shape1.shape);
      const isLine2 = this.isLine(shape2.shape);

      if (isLine1 && isLine2) {
        solutions = this.getLineLineTangent(plane, shape1, shape2, radius);
      }
      else if (isLine1) {
        solutions = this.getLineCircleTangent(plane, shape1, shape2, radius);
      }
      else if (isLine2) {
        solutions = this.getLineCircleTangent(plane, shape2, shape1, radius);
      }
      else {
        solutions = this.getCircleCircleTangent(plane, shape1, shape2, radius);
      }

    }

    const edges = toCircleEdges(solutions, plane);

    for (const solution of solutions) {
      solution.center.delete();
      solution.tangentPoint1.delete();
      solution.tangentPoint2.delete();
    }

    return edges;
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
    let solutions: {
      center: gp_Pnt2d;
      radius: number;
      tangentPoint1: gp_Pnt2d;
      tangentPoint2: gp_Pnt2d;
    }[];

    if (isVertex1 && isVertex2) {
      solutions = this.getPointPointCircleTangent(plane, shape1.shape as Vertex, shape2.shape as Vertex, radius);
    }
    else if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      if (this.isLine(other.shape)) {
        solutions = this.getPointLineTangent(plane, vertex.shape as Vertex, other, radius);
      }
      else {
        solutions = this.getPointCircleTangent(plane, vertex.shape as Vertex, other, radius);
      }
    }
    else {
      const isLine1 = this.isLine(shape1.shape);
      const isLine2 = this.isLine(shape2.shape);

      if (isLine1 && isLine2) {
        solutions = this.getLineLineTangent(plane, shape1, shape2, radius);
      }
      else if (isLine1) {
        solutions = this.getLineCircleTangent(plane, shape1, shape2, radius);
      }
      else if (isLine2) {
        solutions = this.getLineCircleTangent(plane, shape2, shape1, radius);
      }
      else {
        solutions = this.getCircleCircleTangent(plane, shape1, shape2, radius);
      }
    }

    const edges = toArcEdges(solutions, plane);
    const endTangent = calculateTangent(solutions);

    for (const solution of solutions) {
      solution.center.delete();
      solution.tangentPoint1.delete();
      solution.tangentPoint2.delete();
    }

    return {
      edges,
      endTangent
    };
  }

  private isLine(shape: Shape): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const result = adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    adaptor.delete();
    return result;
  }

  private getLineLineTangent(
    plane: Plane,
    lineShape1: QualifiedShape,
    lineShape2: QualifiedShape,
    radius: number
  ) {
    console.log('Getting line-line tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const lineGeometry1 = this.getShapeGeometry(lineShape1.shape);
    const lineGeometry2 = this.getShapeGeometry(lineShape2.shape);
    const qualifiedLine1 = getQualifiedGeometry(pln, lineGeometry1, lineShape1.qualifier);
    const qualifiedLine2 = getQualifiedGeometry(pln, lineGeometry2, lineShape2.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedLine1 as GccEnt_QualifiedLin, qualifiedLine2 as GccEnt_QualifiedLin, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);
    disposePln();
    return solutions;
  }

  private getLineCircleTangent(
    plane: Plane,
    lineShape: QualifiedShape,
    circleShape: QualifiedShape,
    radius: number
  ) {
    console.log('Getting line-circle tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const lineGeometry = this.getShapeGeometry(lineShape.shape);
    const circleGeometry = this.getShapeGeometry(circleShape.shape);
    const qualifiedLine = getQualifiedGeometry(pln, lineGeometry, lineShape.qualifier);
    const qualifiedCircle = getQualifiedGeometry(pln, circleGeometry, circleShape.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedCircle as GccEnt_QualifiedCirc, qualifiedLine as GccEnt_QualifiedLin, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);
    disposePln();
    return solutions;
  }

  private getPointLineTangent(
    plane: Plane,
    vertex: Vertex,
    lineShape: QualifiedShape,
    radius: number
  ) {
    console.log('Getting point-line tangent!');
    console.log('Vertex:', vertex);
    console.log('Line shape:', lineShape);
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    const geometry = this.getShapeGeometry(lineShape.shape);
    const qualifiedGeometry = getQualifiedGeometry(pln, geometry, lineShape.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedGeometry as GccEnt_QualifiedCirc, pnt, radius, tolerance);
    disposePnt();

    const solutions = this.getSolutions(solver, plane);
    disposePln();
    return solutions;
  }

  private getPointPointCircleTangent(
    plane: Plane,
    vertex1: Vertex,
    vertex2: Vertex,
    radius: number
  ) {
    console.log('Getting point-point-circle tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pnt1, disposePnt1] = Convert.toGpPnt2d(vertex1.toPoint2D());
    const [pnt2, disposePnt2] = Convert.toGpPnt2d(vertex2.toPoint2D());

    console.log('Point 1:', pnt1.X(), pnt1.Y());
    console.log('Point 2:', pnt2.X(), pnt2.Y());
    const solver = new oc.GccAna_Circ2d2TanRad(pnt1, pnt2, radius, tolerance);
    disposePnt1();
    disposePnt2();

    const solutions = this.getSolutions(solver, plane);
    console.log('Found edges:', solutions.length);
    return solutions;
  }

  private getPointCircleTangent(
    plane: Plane,
    vertex: Vertex,
    circleShape: QualifiedShape,
    radius: number
  ) {
    console.log('Getting point-circle tangent');

    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    const geometry = this.getShapeGeometry(circleShape.shape);
    const qualifiedGeometry = getQualifiedGeometry(pln, geometry, circleShape.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedGeometry as GccEnt_QualifiedCirc, pnt, radius, tolerance);
    disposePnt();

    const solutions = this.getSolutions(solver, plane);
    disposePln();
    return solutions;
  }

  private getCircleCircleTangent(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ) {
    console.log('Getting circle-circle tangent', shape1, shape2);
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const geometry1 = this.getShapeGeometry(shape1.shape);
    const geometry2 = this.getShapeGeometry(shape2.shape);

    const qualifiedGeometry1 = getQualifiedGeometry(pln, geometry1, shape1.qualifier);
    const qualifiedGeometry2 = getQualifiedGeometry(pln, geometry2, shape2.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedGeometry1 as GccEnt_QualifiedCirc, qualifiedGeometry2 as GccEnt_QualifiedCirc, radius, tolerance);

    const solutions = this.getSolutions(solver, plane);
    disposePln();
    return solutions;
  }

  private getSolutions(solver: GccAna_Circ2d2TanRad, plane: Plane) {
    const oc = getOC();

    const solutions: {
      center: gp_Pnt2d;
      radius: number;
      tangentPoint1: gp_Pnt2d;
      tangentPoint2: gp_Pnt2d;
    }[] = [];

    if (solver.IsDone()) {
      for (let i = 1; i <= solver.NbSolutions(); i++) {
        console.log(`Processing solution ${i} of ${solver.NbSolutions()}`);
        const circ2d = solver.ThisSolution(i);
        const radius = circ2d.Radius();

        console.log('Circle center:', circ2d.Location().X(), circ2d.Location().Y());
        console.log('Circle radius:', radius);

        const pnt1 = new oc.gp_Pnt2d();
        const pnt2 = new oc.gp_Pnt2d();

        try {
          solver.Tangency1(i, 0, 0, pnt1);
        }
        catch (_e) {
          console.warn('Error computing tangency points for solution', i, _e);
        }

        try {
          solver.Tangency2(i, 0, 0, pnt2);
        }
        catch (_e) {
          console.warn('Error computing tangency points for solution', i, _e);
        }

        solutions.push({
          center: circ2d.Location(),
          radius: radius,
          tangentPoint1: pnt1,
          tangentPoint2: pnt2
        });
      }
    }

    return solutions;
  }

  private getShapeGeometry(shape: Shape) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType();
    let geometry: gp_Circ | gp_Lin;

    if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      geometry = adaptor.Line()
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
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
