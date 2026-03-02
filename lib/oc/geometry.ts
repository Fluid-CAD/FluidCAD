import type { GccAna_Circ2d2TanRad, GccAna_Circ2d3Tan, GccAna_Lin2d2Tan, GccEnt_Position, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, Geom2dGcc_Circ2d2TanRad, Geom2dGcc_Circ2d3Tan, Geom2dGcc_Lin2d2Tan, Geom2dGcc_QualifiedCurve, Geom_Circle, Geom_Curve, Geom_TrimmedCurve, gp_Circ, gp_Lin, gp_Pln, gp_Pnt, Handle_Geom_Curve, TopoDS_Edge, TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point, Point2D } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Edge } from "../common/edge.js";
import { ConstraintQualifier, QualifiedGeometry } from "../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Vertex } from "../common/vertex.js";
import { VertexOps } from "./vertex-ops.js";

export class Geometry {
  static makeSegment(p1: Point, p2: Point): Geom_TrimmedCurve {
    const oc = getOC();
    const [transformedP1, disposeP1] = Convert.toGpPnt(p1);
    const [transformedP2, disposeP2] = Convert.toGpPnt(p2);
    const segmentMaker = new oc.GC_MakeSegment(transformedP1, transformedP2);

    if (!segmentMaker.IsDone()) {
      const status = segmentMaker.Status();
      segmentMaker.delete();
      disposeP1();
      disposeP2();
      throw new Error("Failed to create segment: " + status);
    }

    const geometry = segmentMaker.Value().get();
    segmentMaker.delete();
    disposeP1();
    disposeP2();
    return geometry as Geom_TrimmedCurve;
  }

  static makeArcThreePoints(start: Point, end: Point, p3: Point): Geom_TrimmedCurve {
    const oc = getOC();
    const [gpStart, disposeStart] = Convert.toGpPnt(start);
    const [gpEnd, disposeEnd] = Convert.toGpPnt(end);
    const [gpP3, disposeP3] = Convert.toGpPnt(p3);
    const arcMaker = new oc.GC_MakeArcOfCircle(gpStart, gpEnd, gpP3);

    if (arcMaker.IsDone()) {
      const curve = arcMaker.Value().get();
      arcMaker.delete();
      disposeStart();
      disposeEnd();
      disposeP3();
      return curve;
    }

    const status = arcMaker.Status();
    arcMaker.delete();
    disposeStart();
    disposeEnd();
    disposeP3();

    throw new Error('Failed to create arc edge from center: ' + status);
  }

  static makeArc(center: Point, radius: number, normal: Vector3d, start: Point, end: Point): Geom_TrimmedCurve {
    const oc = getOC();
    const [c, disposeC] = Convert.toGpPnt(center);
    const [s, disposeS] = Convert.toGpPnt(start);
    const [e, disposeE] = Convert.toGpPnt(end);
    const [dir, disposeDir] = Convert.toGpDir(normal);

    const ax2 = new oc.gp_Ax2(c, dir);
    const circle = new oc.gp_Circ(ax2, radius);
    const arcMaker = new oc.GC_MakeArcOfCircle(circle, s, e, true);

    let curve: Geom_TrimmedCurve | null = null;
    if (arcMaker.IsDone()) {
      curve = arcMaker.Value().get();
    }

    disposeC();
    disposeS();
    disposeE();
    disposeDir();
    ax2.delete();
    circle.delete();
    arcMaker.delete();

    if (!curve) {
      const status = arcMaker.Status();
      throw new Error('Failed to create arc edge from center: ' + status);
    }

    return curve;
  }

  static makeArcFromAngle(center: Point, radius: number, normal: Vector3d, start: Point, angle: number): Geom_TrimmedCurve {
    const oc = getOC();
    const [gpCenter, disposeCenter] = Convert.toGpPnt(center);
    const [gpDir, disposeDir] = Convert.toGpDir(normal);
    const [gpStart, disposeStart] = Convert.toGpPnt(start);

    const ax2 = new oc.gp_Ax2(gpCenter, gpDir);
    const circle = new oc.gp_Circ(ax2, radius);
    const arcMaker = new oc.GC_MakeArcOfCircle(circle, gpStart, angle, true);

    if (arcMaker.IsDone()) {
      const curve = arcMaker.Value().get();
      arcMaker.delete();
      ax2.delete();
      circle.delete();
      disposeCenter();
      disposeDir();
      disposeStart();
      return curve;
    }

    const status = arcMaker.Status();
    arcMaker.delete();
    ax2.delete();
    circle.delete();
    disposeCenter();
    disposeDir();
    disposeStart();

    throw new Error('Failed to create arc edge from angle:' + status);
  }

  static makeArcFromTangent(start: Point, end: Point, tangent: Vector3d): Geom_TrimmedCurve {
    const oc = getOC();
    const [gpStart, disposeStart] = Convert.toGpPnt(start);
    const [gpTangent, disposeTangent] = Convert.toGpVec(tangent);
    const [gpEnd, disposeEnd] = Convert.toGpPnt(end);
    const arcMaker = new oc.GC_MakeArcOfCircle(gpStart, gpTangent, gpEnd);

    if (arcMaker.IsDone()) {
      const curve = arcMaker.Value().get();
      arcMaker.delete();
      disposeStart();
      disposeTangent();
      disposeEnd();
      return curve;
    }

    const status = arcMaker.Status();
    arcMaker.delete();
    disposeStart();
    disposeTangent();
    disposeEnd();

    throw new Error('Failed to create arc edge from tangent: ' + status);
  }

  static makeCircle(center: Point, radius: number, normal: Vector3d): Geom_Circle {
    const oc = getOC();
    const [gpCenter, disposeCenter] = Convert.toGpPnt(center);
    const [gpDir, disposeDir] = Convert.toGpDir(normal);
    const ax2 = new oc.gp_Ax2(gpCenter, gpDir);
    const gpCircle = new oc.gp_Circ(ax2, radius);
    const circleMaker = new oc.GC_MakeCircle(gpCircle);

    if (circleMaker.IsDone()) {
      const circle = circleMaker.Value().get();
      circleMaker.delete();
      ax2.delete();
      gpCircle.delete();
      disposeCenter();
      disposeDir();
      return circle;
    }

    const status = circleMaker.Status();
    circleMaker.delete();
    ax2.delete();
    gpCircle.delete();
    disposeCenter();
    disposeDir();

    throw new Error('Failed to create circle edge: ' + status);
  }

  // Wrapper methods returning Edge (public API for external callers)
  static makeEdge(geometry: Geom_TrimmedCurve): Edge {
    return Edge.fromTopoDSEdge(Geometry.makeEdgeRaw(geometry));
  }

  static makeEdgeFromCurve(curve: Geom_TrimmedCurve): Edge {
    return Edge.fromTopoDSEdge(Geometry.makeEdgeFromCurveRaw(curve));
  }

  static makeEdgeFromCircle(circle: Geom_Circle): Edge {
    return Edge.fromTopoDSEdge(Geometry.makeEdgeFromCircleRaw(circle));
  }

  // Raw methods returning TopoDS_Edge (for oc-internal use)
  static makeEdgeRaw(geometry: Geom_TrimmedCurve): TopoDS_Edge {
    const oc = getOC();
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(geometry.StartPoint(), geometry.EndPoint());

    if (!edgeMaker.IsDone()) {
      const status = edgeMaker.Error();
      edgeMaker.delete();
      throw new Error("Failed to create edge: " + status);
    }

    const edge = edgeMaker.Edge();
    edgeMaker.delete();
    geometry.delete();
    return edge;
  }

  static makeEdgeFromCurveRaw(curve: Geom_TrimmedCurve): TopoDS_Edge {
    const oc = getOC();
    const handle = new oc.Handle_Geom_Curve(curve);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(handle, curve.StartPoint(), curve.EndPoint());
    if (edgeMaker.IsDone()) {
      const edge = edgeMaker.Edge();
      edgeMaker.delete();
      handle.delete();
      return edge;
    }

    const status = edgeMaker.Error();
    edgeMaker.delete();
    handle.delete();

    throw new Error('Failed to create edge from arc: ' + status);
  }

  static makeEdgeFromCircleRaw(circle: Geom_Circle): TopoDS_Edge {
    const oc = getOC();
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(circle.Circ());

    if (edgeMaker.IsDone()) {
      const edge = edgeMaker.Edge();
      edgeMaker.delete();
      return edge;
    }

    const status = edgeMaker.Error();
    edgeMaker.delete();

    throw new Error('Failed to create edge from circle: ' + status);
  }

  static getPointOnCircle(center: Point2D, radius: number, angle: number): Point2D {
    const x = center.x + radius * Math.cos(angle);
    const y = center.y + radius * Math.sin(angle);
    return new Point2D(x, y);
  }

  static getCircleCenter(point: Point2D, radius: number, angle: number): Point2D {
    const x = point.x - radius * Math.cos(angle);
    const y = point.y - radius * Math.sin(angle);

    return new Point2D(x, y);
  }

  static get2dLineRaw(plane: gp_Pln, geometry: gp_Lin) {
    const oc = getOC()
    const geom = oc.ProjLib.Project(plane, geometry);
    return geom;
  }

  static get2dCircleRaw(plane: gp_Pln, geometry: gp_Circ) {
    const oc = getOC()
    const geom = oc.ProjLib.Project(plane, geometry);
    return geom;
  }

  static get2dCurveRaw(plane: gp_Pln, curveHandle: Handle_Geom_Curve) {
    const oc = getOC()
    const converted = oc.GeomAPI.To2d(curveHandle, plane);
    return converted;
  }

  static getTangentLines(plane: Plane, qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry) {

    const oc = getOC();
    const tolerance = oc.Precision.Angular();

    const [pln, disposePln] = Convert.toGpPln(plane);

    const c1 = this.getQualified(pln, qualifiedC1);
    const c2 = this.getQualified(pln, qualifiedC2);

    let solver: GccAna_Lin2d2Tan | Geom2dGcc_Lin2d2Tan;

    console.log(`Finding tangent lines between: c1 type=${c1.type}, c2 type=${c2.type}`);

    if (c1.type === 'circle' && c2.type === 'circle') {
      solver = new oc.GccAna_Lin2d2Tan(c1.qualified as any, c2.qualified as any, tolerance);
    }
    else if (c1.type === 'circle' && c2.type === 'point') {
      const localPoint = plane.worldToLocal(Convert.toPoint(c2.qualified as gp_Pnt));
      console.log(`Projected point for tangency: (${localPoint.x}, ${localPoint.y})`);

      const [gpPnt, disposeGpPnt] = Convert.toGpPnt2d(localPoint);
      console.log(`Qualified curve type: ${c1.qualified}`);
      solver = new oc.GccAna_Lin2d2Tan(c1.qualified as any, gpPnt, tolerance);
      disposeGpPnt();
    }
    else {
      const qc1 = this.getQualifiedAsCurve(pln, qualifiedC1);
      const qc2 = this.getQualifiedAsCurve(pln, qualifiedC2);
      solver = new oc.Geom2dGcc_Lin2d2Tan(qc1, qc2, tolerance);
    }

    disposePln();

    const edges: Edge[] = [];

    if (solver.IsDone()) {
      const nSolutions = solver.NbSolutions();
      console.log(`Found ${nSolutions} tangent lines`);

      for (let i = 1; i <= nSolutions; i++) {
        const line2d = solver.ThisSolution(i);

        const loc = line2d.Location();
        const dir = line2d.Direction();
        console.log(`Solution ${i}: point(${loc.X()}, ${loc.Y()}), dir(${dir.X()}, ${dir.Y()})`);

        const pnt1 = new oc.gp_Pnt2d();
        const pnt2 = new oc.gp_Pnt2d();
        solver.Tangency1(i, 0, 0, pnt1);
        solver.Tangency2(i, 0, 0, pnt2);

        const worldPnt1 = plane.localToWorld(Convert.toPoint2D(pnt1, true));
        const worldPnt2 = plane.localToWorld(Convert.toPoint2D(pnt2, true));

        const line = Geometry.makeSegment(worldPnt1, worldPnt2);
        const edge = Geometry.makeEdge(line);

        edges.push(edge);
      }
    }

    return edges;
  }

  static getQualifiedCurve(plane: gp_Pln, shape: Shape, qualifiedGeometry: QualifiedGeometry) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType()

    if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      console.log('Qualified geometry is a circle');
      // full circle
      console.log('Adaptor is closed:', adaptor.IsClosed());
      if (adaptor.IsClosed()) {
        const circle = adaptor.Circle();
        adaptor.delete();

        const c1 = Geometry.get2dCircleRaw(plane, circle);
        circle.delete();

        const qualifier = Geometry.getQualifier(qualifiedGeometry.qualifier);
        const qualified = new oc.GccEnt_QualifiedCirc(c1, qualifier);

        return { qualified, type: 'circle' };
      }
      else {
        // curve
        const curveAdaptor = adaptor.Curve();
        const curve = curveAdaptor.Curve();
        curveAdaptor.delete();
        adaptor.delete();

        const c1 = Geometry.get2dCurveRaw(plane, curve);

        const adaptorCurve = new oc.Geom2dAdaptor_Curve(c1);

        const qualifier = Geometry.getQualifier(qualifiedGeometry.qualifier);
        const qualified = new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);

        return { qualified, type: 'curve' };
      }
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = adaptor.Line();
      adaptor.delete();

      const l1 = Geometry.get2dLineRaw(plane, line);
      line.delete();

      const qualifier = this.getQualifier(qualifiedGeometry.qualifier);
      const qualified = new oc.GccEnt_QualifiedLin(l1, qualifier);

      return { qualified, type: 'line' };
    }
  }

  static getQualified(plane: gp_Pln, qualifiedGeometry: QualifiedGeometry) {
    const shape = qualifiedGeometry.object.getShapes(false)[0];

    if (shape.getType() === 'wire' || shape.getType() === 'edge') {
      return this.getQualifiedCurve(plane, shape, qualifiedGeometry);
    }
    else if (shape.getType() === 'vertex') {
      const oc = getOC();
      const vertex = shape.getShape() as TopoDS_Vertex;
      const pnt = oc.BRep_Tool.Pnt(vertex);
      return {
        qualified: pnt,
        type: 'point'
      }
    }

    throw new Error('Unsupported shape type for constraint');
  }

  static getQualifier(qualifier: ConstraintQualifier): GccEnt_Position {
    const oc = getOC();
    switch (qualifier) {
      case 'unqualified':
        return oc.GccEnt_Position.GccEnt_unqualified;
      case 'enclosed':
        return oc.GccEnt_Position.GccEnt_enclosed;
      case 'enclosing':
        return oc.GccEnt_Position.GccEnt_enclosing;
      case 'outside':
        return oc.GccEnt_Position.GccEnt_outside;
    }
  }

  private static getQualifiedAsCurve(plane: gp_Pln, qualifiedGeometry: QualifiedGeometry): Geom2dGcc_QualifiedCurve {
    const oc = getOC();
    const shape = qualifiedGeometry.object.getShapes(false)[0];
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType();
    const qualifier = Geometry.getQualifier(qualifiedGeometry.qualifier);

    if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      if (adaptor.FirstParameter() === adaptor.LastParameter()) {
        // full circle → Geom2d_Circle → Geom2dAdaptor_Curve → QualifiedCurve
        const circle = adaptor.Circle();
        adaptor.delete();
        const circ2d = Geometry.get2dCircleRaw(plane, circle);
        circle.delete();
        const geom2dCircle = new oc.Geom2d_Circle(circ2d);
        const handle = new oc.Handle_Geom2d_Curve(geom2dCircle);
        const adaptorCurve = new oc.Geom2dAdaptor_Curve(handle);
        return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
      } else {
        // arc → use existing curve conversion
        const curveAdaptor = adaptor.Curve();
        const curve = curveAdaptor.Curve();
        curveAdaptor.delete();
        adaptor.delete();
        const c2d = Geometry.get2dCurveRaw(plane, curve);
        const adaptorCurve = new oc.Geom2dAdaptor_Curve(c2d);
        return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
      }
    } else if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      // line → Geom2d_Line → Geom2dAdaptor_Curve → QualifiedCurve
      const line = adaptor.Line();
      adaptor.delete();
      const lin2d = Geometry.get2dLineRaw(plane, line);
      line.delete();
      const geom2dLine = new oc.Geom2d_Line(lin2d);
      const handle = new oc.Handle_Geom2d_Curve(geom2dLine);
      const adaptorCurve = new oc.Geom2dAdaptor_Curve(handle);
      return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
    } else {
      // generic curve
      const curveAdaptor = adaptor.Curve();
      const curve = curveAdaptor.Curve();
      curveAdaptor.delete();
      adaptor.delete();
      const c2d = Geometry.get2dCurveRaw(plane, curve);
      const adaptorCurve = new oc.Geom2dAdaptor_Curve(c2d);
      return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
    }
  }

  static getTangentCircles(plane: Plane, qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry, radius: number) {

    const oc = getOC();
    const tolerance = oc.Precision.Confusion();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const c1 = this.getQualified(pln, qualifiedC1);
    const c2 = this.getQualified(pln, qualifiedC2);

    let solver: GccAna_Circ2d2TanRad | Geom2dGcc_Circ2d2TanRad;
    if (c1.type === 'circle' && c2.type === 'circle') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedCirc, c2.qualified as GccEnt_QualifiedCirc, radius, tolerance);
    } else if (c1.type === 'circle' && c2.type === 'line') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedCirc, c2.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'line' && c2.type === 'circle') {
      solver = new oc.GccAna_Circ2d2TanRad(c2.qualified as GccEnt_QualifiedCirc, c1.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'line' && c2.type === 'line') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedLin, c2.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else {
      const qc1 = this.getQualifiedAsCurve(pln, qualifiedC1);
      const qc2 = this.getQualifiedAsCurve(pln, qualifiedC2);
      solver = new oc.Geom2dGcc_Circ2d2TanRad(qc1, qc2, radius, tolerance);
    }

    disposePln();

    const edges: Edge[] = [];

    if (solver.IsDone()) {
      const nSolutions = solver.NbSolutions();
      console.log(`Found ${nSolutions} tangent circles (2tan+rad)`);

      for (let i = 1; i <= nSolutions; i++) {
        const circ2d = solver.ThisSolution(i);
        const center2d = Convert.toPoint2D(circ2d.Location());
        const worldCenter = plane.localToWorld(center2d);
        const r = circ2d.Radius();

        const circle = Geometry.makeCircle(worldCenter, r, plane.normal);
        const edge = Geometry.makeEdgeFromCircle(circle);
        edges.push(edge);
      }
    }

    return edges;
  }

  static getTangentArcs(plane: Plane, qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry, radius: number) {

    const oc = getOC();
    const tolerance = oc.Precision.Confusion();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const c1 = this.getQualified(pln, qualifiedC1);
    const c2 = this.getQualified(pln, qualifiedC2);

    let solver: GccAna_Circ2d2TanRad | Geom2dGcc_Circ2d2TanRad;
    if (c1.type === 'circle' && c2.type === 'circle') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedCirc, c2.qualified as GccEnt_QualifiedCirc, radius, tolerance);
    } else if (c1.type === 'circle' && c2.type === 'line') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedCirc, c2.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'line' && c2.type === 'circle') {
      solver = new oc.GccAna_Circ2d2TanRad(c2.qualified as GccEnt_QualifiedCirc, c1.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else if (c1.type === 'line' && c2.type === 'line') {
      solver = new oc.GccAna_Circ2d2TanRad(c1.qualified as GccEnt_QualifiedLin, c2.qualified as GccEnt_QualifiedLin, radius, tolerance);
    } else {
      const qc1 = this.getQualifiedAsCurve(pln, qualifiedC1);
      const qc2 = this.getQualifiedAsCurve(pln, qualifiedC2);
      solver = new oc.Geom2dGcc_Circ2d2TanRad(qc1, qc2, radius, tolerance);
    }

    disposePln();

    const results: { edge: Edge, endTangent: Point2D }[] = [];

    if (solver.IsDone()) {
      const nSolutions = solver.NbSolutions();
      console.log(`Found ${nSolutions} tangent arcs (2tan+rad)`);

      for (let i = 1; i <= nSolutions; i++) {
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

        // Compute shorter-arc midpoint in 2D plane coords to unambiguously pick the fillet arc
        const angle1 = Math.atan2(pnt1.Y() - center2d.y, pnt1.X() - center2d.x);
        const angle2 = Math.atan2(pnt2.Y() - center2d.y, pnt2.X() - center2d.x);

        pnt1.delete();
        pnt2.delete();

        let diff = angle2 - angle1;
        if (diff > Math.PI) { diff -= 2 * Math.PI; }
        if (diff < -Math.PI) { diff += 2 * Math.PI; }

        const midAngle = angle1 + diff / 2;
        const mid2d = new Point2D(
          center2d.x + r * Math.cos(midAngle),
          center2d.y + r * Math.sin(midAngle)
        );
        const worldMid = plane.localToWorld(mid2d);

        const arc = Geometry.makeArcThreePoints(worldPnt1, worldMid, worldPnt2);
        const edge = Geometry.makeEdgeFromCurve(arc);

        // Tangent at arc end: perpendicular to radius at pnt2, signed by sweep direction
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

  static getTangentCircles3Tan(plane: Plane, qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry, qualifiedC3: QualifiedGeometry) {

    const oc = getOC();
    const tolerance = oc.Precision.Confusion();
    const [pln, disposePln] = Convert.toGpPln(plane);

    const inputs = [
      { q: qualifiedC1, r: this.getQualified(pln, qualifiedC1) },
      { q: qualifiedC2, r: this.getQualified(pln, qualifiedC2) },
      { q: qualifiedC3, r: this.getQualified(pln, qualifiedC3) },
    ];

    // Sort: circles first, then lines
    const circles = inputs.filter(i => i.r.type === 'circle');
    const lines = inputs.filter(i => i.r.type === 'line');
    const curves = inputs.filter(i => i.r.type === 'curve');

    let solver: GccAna_Circ2d3Tan | Geom2dGcc_Circ2d3Tan;

    if (curves.length > 0) {
      // Fallback to Geom2dGcc for any curve type
      const qc1 = this.getQualifiedAsCurve(pln, qualifiedC1);
      const qc2 = this.getQualifiedAsCurve(pln, qualifiedC2);
      const qc3 = this.getQualifiedAsCurve(pln, qualifiedC3);
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
      // 3 lines
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
      const nSolutions = solver.NbSolutions();
      console.log(`Found ${nSolutions} tangent circles (3tan)`);

      for (let i = 1; i <= nSolutions; i++) {
        const circ2d = solver.ThisSolution(i);
        const center2d = Convert.toPoint2D(circ2d.Location());
        const worldCenter = plane.localToWorld(center2d);
        const r = circ2d.Radius();

        const circle = Geometry.makeCircle(worldCenter, r, plane.normal);
        const edge = Geometry.makeEdgeFromCircle(circle);
        edges.push(edge);
      }
    }

    return edges;
  }
}
