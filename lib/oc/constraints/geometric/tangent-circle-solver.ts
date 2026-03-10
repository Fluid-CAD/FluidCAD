import { GccAna_Circ2d2TanRad, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, gp_Circ, gp_Lin } from "occjs-wrapper";
import { Edge } from "../../../common/edge.js";
import { Shape } from "../../../common/shape.js";
import { Vertex } from "../../../common/vertex.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { getQualifiedGeometry } from "../constraint-helpers.js";
import { Convert } from "../../convert.js";
import { getOC } from "../../init.js";
import { Geometry } from "../../geometry.js";
import { TangentCircleSolver } from "../constraint-solver.js";

export class GeometricTangentCircleSolver implements TangentCircleSolver {
  getTangentCircles(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): Edge[] {
    const isVertex1 = shape1.shape instanceof Vertex;
    const isVertex2 = shape2.shape instanceof Vertex;

    if (isVertex1 && isVertex2) {
      return this.getPointPointCircleTangent(plane, shape1.shape as Vertex, shape2.shape as Vertex, radius);
    }

    if (isVertex1 || isVertex2) {
      const vertex = isVertex1 ? shape1 : shape2;
      const other = isVertex1 ? shape2 : shape1;
      if (this.isLine(other.shape)) {
        return this.getPointLineTangent(plane, vertex.shape as Vertex, other, radius);
      }
      return this.getPointCircleTangent(plane, vertex.shape as Vertex, other, radius);
    }

    const isLine1 = this.isLine(shape1.shape);
    const isLine2 = this.isLine(shape2.shape);

    if (isLine1 && isLine2) {
      return this.getLineLineTangent(plane, shape1, shape2, radius);
    }
    if (isLine1) {
      return this.getLineCircleTangent(plane, shape1, shape2, radius);
    }
    if (isLine2) {
      return this.getLineCircleTangent(plane, shape2, shape1, radius);
    }
    return this.getCircleCircleTangent(plane, shape1, shape2, radius);
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
  ): Edge[] {
    console.log('Getting line-line tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const lineGeometry1 = this.getShapeGeometry(lineShape1.shape);
    const lineGeometry2 = this.getShapeGeometry(lineShape2.shape);
    const qualifiedLine1 = getQualifiedGeometry(pln, lineGeometry1, lineShape1.qualifier);
    const qualifiedLine2 = getQualifiedGeometry(pln, lineGeometry2, lineShape2.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedLine1 as GccEnt_QualifiedLin, qualifiedLine2 as GccEnt_QualifiedLin, radius, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private getLineCircleTangent(
    plane: Plane,
    lineShape: QualifiedShape,
    circleShape: QualifiedShape,
    radius: number
  ): Edge[] {
    console.log('Getting line-circle tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const lineGeometry = this.getShapeGeometry(lineShape.shape);
    const circleGeometry = this.getShapeGeometry(circleShape.shape);
    const qualifiedLine = getQualifiedGeometry(pln, lineGeometry, lineShape.qualifier);
    const qualifiedCircle = getQualifiedGeometry(pln, circleGeometry, circleShape.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedCircle as GccEnt_QualifiedCirc, qualifiedLine as GccEnt_QualifiedLin, radius, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private getPointLineTangent(
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
    const geometry = this.getShapeGeometry(lineShape.shape);
    const qualifiedGeometry = getQualifiedGeometry(pln, geometry, lineShape.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedGeometry as GccEnt_QualifiedCirc, pnt, radius, tolerance);
    disposePnt();

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private getPointPointCircleTangent(
    plane: Plane,
    vertex1: Vertex,
    vertex2: Vertex,
    radius: number
  ): Edge[] {
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

    const edges = this.collectSolverEdges(solver, plane);
    console.log('Found edges:', edges.length);
    return edges;
  }

  private getPointCircleTangent(
    plane: Plane,
    vertex: Vertex,
    circleShape: QualifiedShape,
    radius: number
  ): Edge[] {
    console.log('Getting point-circle tangent');
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const [pnt, disposePnt] = Convert.toGpPnt2d(vertex.toPoint2D());
    const geometry = this.getShapeGeometry(circleShape.shape);
    const qualifiedGeometry = getQualifiedGeometry(pln, geometry, circleShape.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedGeometry as GccEnt_QualifiedCirc, pnt, radius, tolerance);
    disposePnt();

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private getCircleCircleTangent(
    plane: Plane,
    shape1: QualifiedShape,
    shape2: QualifiedShape,
    radius: number
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const geometry1 = this.getShapeGeometry(shape1.shape);
    const geometry2 = this.getShapeGeometry(shape2.shape);
    const qualifiedGeometry1 = getQualifiedGeometry(pln, geometry1, shape1.qualifier);
    const qualifiedGeometry2 = getQualifiedGeometry(pln, geometry2, shape2.qualifier);

    const solver = new oc.GccAna_Circ2d2TanRad(qualifiedGeometry1 as GccEnt_QualifiedCirc, qualifiedGeometry2 as GccEnt_QualifiedCirc, radius, tolerance);

    const edges = this.collectSolverEdges(solver, plane);
    disposePln();
    return edges;
  }

  private collectSolverEdges(solver: GccAna_Circ2d2TanRad, plane: Plane): Edge[] {
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
