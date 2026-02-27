import type { GccEnt_Position, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, Geom_Circle, Geom_TrimmedCurve, gp_Circ, gp_Lin, gp_Pln, gp_Pnt, TopoDS_Edge } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point, Point2D } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Edge } from "../common/edge.js";
import { ConstraintQualifier, QualifiedGeometry } from "../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../math/plane.js";

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

  static getCircleTangentLines(plane: Plane, qualifiedC1: QualifiedGeometry,
    qualifiedC2: QualifiedGeometry) {

    const oc = getOC();
    const tolerance = oc.Precision.Angular();

    const [pln, disposePln] = Convert.toGpPln(plane);

    const c1 = this.getQualified(pln, qualifiedC1) as GccEnt_QualifiedCirc;
    const c2 = this.getQualified(pln, qualifiedC2) as GccEnt_QualifiedCirc;

    const solver = new oc.GccAna_Lin2d2Tan(c1, c2, tolerance);

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

  static getQualified(plane: gp_Pln, qualifiedGeometry: QualifiedGeometry): GccEnt_QualifiedCirc | GccEnt_QualifiedLin {
    const oc = getOC();
    const shape = qualifiedGeometry.object.getShapes()[0];
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType()

    if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const circle = adaptor.Circle();
      adaptor.delete();

      const c1 = Geometry.get2dCircleRaw(plane, circle);
      circle.delete();

      const qualifier = Geometry.getQualifier(qualifiedGeometry.qualifier);
      const qualified = new oc.GccEnt_QualifiedCirc(c1, qualifier);

      return qualified;
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = adaptor.Line();
      adaptor.delete();

      const l1 = Geometry.get2dLineRaw(plane, line);
      line.delete();

      const qualifier = this.getQualifier(qualifiedGeometry.qualifier);
      const qualified = new oc.GccEnt_QualifiedLin(l1, qualifier);

      return qualified;
    }

    throw new Error('Unsupported shape type for constraint: ' + type);
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
}
