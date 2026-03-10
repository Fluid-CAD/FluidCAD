import type { GccAna_Circ2d2TanRad, GccAna_Circ2d3Tan, GccAna_Lin2d2Tan, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, Geom2dGcc_Circ2d2TanRad, Geom2dGcc_Circ2d3Tan, Geom2dGcc_Lin2d2Tan, Geom2dGcc_QualifiedCurve, gp_Pnt } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point2D } from "../math/point.js";
import { Edge } from "../common/edge.js";
import { QualifiedGeometry } from "../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../math/plane.js";
import { Geometry } from "./geometry.js";
import { ConstraintResolver, ResolvedGeometry } from "./constraint-resolver.js";
import { Wire } from "../common/wire.js";
import { Vertex } from "../common/vertex.js";

export class TangentSolver {
  static getTangentLines(
    plane: Plane,
    qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Angular();
    const [pln, disposePln] = Convert.toGpPln(plane);

    let shape1 = qualifiedC1.object.getShapes({ excludeMeta: false })[0];
    let shape2 = qualifiedC2.object.getShapes({ excludeMeta: false })[0];

    if (shape1 instanceof Wire) {
      shape1 = shape1.getEdges()[0];
    }

    if (shape2 instanceof Wire) {
      shape2 = shape2.getEdges()[0];
    }

    let qc1: ResolvedGeometry;
    let qc2: ResolvedGeometry;

    if (shape1 instanceof Vertex || shape2 instanceof Vertex) {
      // const oc = getOC();
      // const vertex = shape.getShape() as TopoDS_Vertex;
      // const pnt = oc.BRep_Tool.Pnt(vertex);

      //       const localPoint = plane.worldToLocal(Convert.toPoint(c2.qualified as gp_Pnt));
      // const [gpPnt, disposeGpPnt] = Convert.toGpPnt2d(localPoint);
      // solver = new oc.GccAna_Lin2d2Tan(c1.qualified as any, gpPnt, tolerance);
      // disposeGpPnt();

      throw new Error('TODO');
    }

    const adaptor1 = new oc.BRepAdaptor_Curve(shape1.getShape());
    const adaptor2 = new oc.BRepAdaptor_Curve(shape2.getShape());

    const type1 = adaptor1.GetType();
    const type2 = adaptor2.GetType();

    let solver: GccAna_Lin2d2Tan | Geom2dGcc_Lin2d2Tan;

    if (type1 === oc.GeomAbs_CurveType.GeomAbs_Circle && type2 === oc.GeomAbs_CurveType.GeomAbs_Circle && adaptor1.IsClosed() && adaptor2.IsClosed()) {
      const c1 = ConstraintResolver.getQualified(pln, qualifiedC1);
      const c2 = ConstraintResolver.getQualified(pln, qualifiedC2);
      solver = new oc.GccAna_Lin2d2Tan(c1.qualified as any, c2.qualified as any, tolerance);
    }
    else {
      const c1 = ConstraintResolver.getQualifiedAsCurve(pln, adaptor1,ConstraintResolver.getQualifier(qualifiedC1.qualifier));
      const c2 = ConstraintResolver.getQualifiedAsCurve(pln, adaptor2, ConstraintResolver.getQualifier(qualifiedC2.qualifier));
      solver = new oc.Geom2dGcc_Lin2d2Tan(c1, c2, tolerance);
    }

    disposePln();

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

  static getTangentCircles(
    plane: Plane,
    qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry,
    radius: number
  ): Edge[] {
    const solver = TangentSolver.buildCirc2TanSolver(plane, qualifiedC1, qualifiedC2, radius);
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

  static getTangentArcs(
    plane: Plane,
    qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry,
    radius: number
  ): { edge: Edge; endTangent: Point2D }[] {
    const oc = getOC();
    const solver = TangentSolver.buildCirc2TanSolver(plane, qualifiedC1, qualifiedC2, radius);
    const results: { edge: Edge; endTangent: Point2D }[] = [];

    if (solver.IsDone()) {
      for (let i = 1; i <= solver.NbSolutions(); i++) {
        const circ2d = solver.ThisSolution(i);
        const center2d = Convert.toPoint2D(circ2d.Location());
        const worldCenter = plane.localToWorld(center2d);
        const r = circ2d.Radius();

        const pnt1 = new oc.gp_Pnt2d();
        const pnt2 = new oc.gp_Pnt2d();
        solver.Tangency1(i, 0, 0, pnt1);
        solver.Tangency2(i, 0, 0, pnt2);

        const worldPnt1 = plane.localToWorld(Convert.toPoint2D(pnt1, false));
        const worldPnt2 = plane.localToWorld(Convert.toPoint2D(pnt2, false));

        const angle1 = Math.atan2(pnt1.Y() - center2d.y, pnt1.X() - center2d.x);
        const angle2 = Math.atan2(pnt2.Y() - center2d.y, pnt2.X() - center2d.x);

        pnt1.delete();
        pnt2.delete();

        let diff = angle2 - angle1;
        if (diff > Math.PI) { diff -= 2 * Math.PI; }
        if (diff < -Math.PI) { diff += 2 * Math.PI; }

        const midAngle = angle1 + diff / 2;
        const worldMid = plane.localToWorld(new Point2D(
          center2d.x + r * Math.cos(midAngle),
          center2d.y + r * Math.sin(midAngle)
        ));

        const arc = Geometry.makeArcThreePoints(worldPnt1, worldMid, worldPnt2);
        const edge = Geometry.makeEdgeFromCurve(arc);

        const sign = diff > 0 ? 1 : -1;
        const endTangent = new Point2D(
          sign * (-Math.sin(angle2)),
          sign * Math.cos(angle2)
        );

        results.push({ edge, endTangent });
      }
    }

    return results;
  }

  static getTangentCircles3Tan(
    plane: Plane,
    qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry,
    qualifiedC3: QualifiedGeometry
  ): Edge[] {
    const oc = getOC();
    const tolerance = oc.Precision.Confusion();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const inputs = [
      { q: qualifiedC1, r: ConstraintResolver.getQualified(pln, qualifiedC1) },
      { q: qualifiedC2, r: ConstraintResolver.getQualified(pln, qualifiedC2) },
      { q: qualifiedC3, r: ConstraintResolver.getQualified(pln, qualifiedC3) },
    ];

    const circles = inputs.filter(i => i.r.type === 'circle');
    const lines = inputs.filter(i => i.r.type === 'line');
    const curves = inputs.filter(i => i.r.type === 'curve');

    let solver: GccAna_Circ2d3Tan | Geom2dGcc_Circ2d3Tan;

    if (curves.length > 0) {
      const qc1 = ConstraintResolver.getQualifiedAsCurve(pln, qualifiedC1);
      const qc2 = ConstraintResolver.getQualifiedAsCurve(pln, qualifiedC2);
      const qc3 = ConstraintResolver.getQualifiedAsCurve(pln, qualifiedC3);
      solver = new oc.Geom2dGcc_Circ2d3Tan(qc1, qc2, qc3, tolerance, 0, 0, 0);
    } else if (circles.length === 3) {
      solver = new oc.GccAna_Circ2d3Tan(
        circles[0].r.qualified as GccEnt_QualifiedCirc,
        circles[1].r.qualified as GccEnt_QualifiedCirc,
        circles[2].r.qualified as GccEnt_QualifiedCirc,
        tolerance
      );
    } else if (circles.length === 2 && lines.length === 1) {
      solver = new oc.GccAna_Circ2d3Tan(
        circles[0].r.qualified as GccEnt_QualifiedCirc,
        circles[1].r.qualified as GccEnt_QualifiedCirc,
        lines[0].r.qualified as GccEnt_QualifiedLin,
        tolerance
      );
    } else if (circles.length === 1 && lines.length === 2) {
      solver = new oc.GccAna_Circ2d3Tan(
        circles[0].r.qualified as GccEnt_QualifiedCirc,
        lines[0].r.qualified as GccEnt_QualifiedLin,
        lines[1].r.qualified as GccEnt_QualifiedLin,
        tolerance
      );
    } else {
      solver = new oc.GccAna_Circ2d3Tan(
        lines[0].r.qualified as GccEnt_QualifiedLin,
        lines[1].r.qualified as GccEnt_QualifiedLin,
        lines[2].r.qualified as GccEnt_QualifiedLin,
        tolerance
      );
    }

    disposePln();

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

  private static buildCirc2TanSolver(
    plane: Plane,
    qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry,
    radius: number
  ): GccAna_Circ2d2TanRad | Geom2dGcc_Circ2d2TanRad {
    const oc = getOC();
    const tolerance = oc.Precision.Confusion();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const c1 = ConstraintResolver.getQualified(pln, qualifiedC1);
    const c2 = ConstraintResolver.getQualified(pln, qualifiedC2);

    let solver: GccAna_Circ2d2TanRad | Geom2dGcc_Circ2d2TanRad;

    if (c1.type === 'circle' && c2.type === 'circle') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedCirc, c2.qualified as GccEnt_QualifiedCirc, radius, tolerance);
    } else if (c1.type === 'circle' && c2.type === 'line') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedCirc, c2.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'line' && c2.type === 'circle') {
      solver = new oc.GccAna_Circ2d2TanRad(c2.qualified as GccEnt_QualifiedCirc, c1.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'line' && c2.type === 'line') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedLin, c2.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'point' && c2.type === 'point') {
      const localPoint1 = plane.worldToLocal(Convert.toPoint(c1.qualified as gp_Pnt));
      const localPoint2 = plane.worldToLocal(Convert.toPoint(c2.qualified as gp_Pnt));
      const [gpPnt1, disposeGpPnt1] = Convert.toGpPnt2d(localPoint1);
      const [gpPnt2, disposeGpPnt2] = Convert.toGpPnt2d(localPoint2);
      solver = new oc.GccAna_Circ2d2TanRad(gpPnt1, gpPnt2, radius, tolerance);
      disposeGpPnt1();
      disposeGpPnt2();
    } else {
      const qc1 = ConstraintResolver.getQualifiedAsCurve(pln, qualifiedC1);
      const qc2 = ConstraintResolver.getQualifiedAsCurve(pln, qualifiedC2);
      solver = new oc.Geom2dGcc_Circ2d2TanRad(qc1, qc2, radius, tolerance);
    }

    disposePln();
    return solver;
  }
}
