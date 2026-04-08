import type { Geom_BezierCurve, Geom_Circle, Geom_TrimmedCurve, Handle_Geom_Curve, TopoDS_Edge } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point, Point2D } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Edge } from "../common/edge.js";

export class Geometry {
  // ── Shape factories ────────────────────────────────────────────────────────

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
      throw new Error('Failed to create arc edge from center');
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

  static makeBezierCurve(poles: Point[]): Geom_BezierCurve {
    const oc = getOC();
    const polesArray = new oc.TColgp_Array1OfPnt(1, poles.length);
    const disposers: (() => void)[] = [];

    for (let i = 0; i < poles.length; i++) {
      const [gpPnt, dispose] = Convert.toGpPnt(poles[i]);
      polesArray.SetValue(i + 1, gpPnt);
      disposers.push(dispose);
    }

    const curve = new oc.Geom_BezierCurve(polesArray);

    polesArray.delete();
    for (const dispose of disposers) {
      dispose();
    }

    return curve as Geom_BezierCurve;
  }

  static makeEdgeFromBezier(curve: Geom_BezierCurve): Edge {
    const oc = getOC();
    const handle = new oc.Handle_Geom_Curve(curve as any);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(handle, curve.StartPoint(), curve.EndPoint());

    if (edgeMaker.IsDone()) {
      const edge = edgeMaker.Edge();
      edgeMaker.delete();
      handle.delete();
      return Edge.fromTopoDSEdge(edge);
    }

    const status = edgeMaker.Error();
    edgeMaker.delete();
    handle.delete();

    throw new Error('Failed to create edge from bezier curve: ' + status);
  }

  // ── Edge factories ─────────────────────────────────────────────────────────

  static makeEdge(geometry: Geom_TrimmedCurve): Edge {
    return Edge.fromTopoDSEdge(Geometry.makeEdgeRaw(geometry));
  }

  static makeEdgeFromCurve(curve: Geom_TrimmedCurve): Edge {
    return Edge.fromTopoDSEdge(Geometry.makeEdgeFromCurveRaw(curve));
  }

  static makeEdgeFromCircle(circle: Geom_Circle): Edge {
    return Edge.fromTopoDSEdge(Geometry.makeEdgeFromCircleRaw(circle));
  }

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

  // ── 2D math helpers ────────────────────────────────────────────────────────

  static getPointOnCircle(center: Point2D, radius: number, angle: number): Point2D {
    return new Point2D(
      center.x + radius * Math.cos(angle),
      center.y + radius * Math.sin(angle)
    );
  }

  static getCircleCenter(point: Point2D, radius: number, angle: number): Point2D {
    return new Point2D(
      point.x - radius * Math.cos(angle),
      point.y - radius * Math.sin(angle)
    );
  }
}
