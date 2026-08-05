import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { Point2D } from "../../../math/point.js";
import { Convert } from "../../convert.js";
import { EdgeQuery } from "../../edge-query.js";
import { Geometry } from "../../geometry.js";
import { getOC } from "../../init.js";

const EPS = 1e-10;

/**
 * Rounded authored inputs (the sketcher emits 2dp coordinates) land the
 * tangency near — but not exactly on — the target edge's endpoint. Within
 * this tolerance the arc end snaps to the vertex so a loop closed through
 * the target's endpoint is exactly closed; landing just outside the target's
 * trimmed span otherwise leaves a micro-gap that silently kills region
 * detection.
 */
const ENDPOINT_SNAP_TOLERANCE = 0.02;

type TargetGeom =
  | { type: 'line'; pointOnLine: Point2D; direction: Point2D }
  | { type: 'circle'; center: Point2D; radius: number };

export function solveTangentArcRadiusToObject(
  plane: Plane,
  startPoint: Point2D,
  startTangent: Point2D,
  signedRadius: number,
  target: QualifiedShape
): { edges: Edge[]; endTangent: Point2D | null } {
  if (Math.abs(signedRadius) < EPS) {
    throw new Error('tArc(radius, target): radius must be non-zero');
  }

  const tlen = startTangent.length();
  if (tlen < EPS) {
    throw new Error('tArc(radius, target): start tangent has zero magnitude');
  }
  const Tx = startTangent.x / tlen;
  const Ty = startTangent.y / tlen;
  // N̂: 90° CCW from T̂. Signed radius > 0 puts center on +N̂ (left) → CCW arc.
  const Nx = -Ty;
  const Ny = Tx;

  const Ox = startPoint.x + signedRadius * Nx;
  const Oy = startPoint.y + signedRadius * Ny;
  const center = new Point2D(Ox, Oy);
  const radius = Math.abs(signedRadius);
  const ccw = signedRadius > 0;

  const targetGeom = extractTargetGeometry(plane, target);
  const intersections = findIntersections(center, radius, targetGeom);
  if (intersections.length === 0) {
    throw new Error('tArc(radius, target): arc circle does not intersect target');
  }

  const startAngle = Math.atan2(startPoint.y - Oy, startPoint.x - Ox);
  let best: { endPoint: Point2D; sweep: number; endAngle: number } | null = null;
  for (const Q of intersections) {
    const endAngle = Math.atan2(Q.y - Oy, Q.x - Ox);
    let sweep = endAngle - startAngle;
    if (ccw) {
      if (sweep < 0) { sweep += 2 * Math.PI; }
    } else {
      if (sweep > 0) { sweep -= 2 * Math.PI; }
    }
    // Skip degenerate "no-sweep" intersections (start point itself on target).
    if (Math.abs(sweep) < EPS) { continue; }
    if (!best || Math.abs(sweep) < Math.abs(best.sweep)) {
      best = { endPoint: Q, sweep, endAngle };
    }
  }

  if (!best) {
    throw new Error('tArc(radius, target): no intersection reachable in the arc direction');
  }

  const snapped = snapToTargetVertex(plane, best.endPoint, target);
  const endPoint = snapped ?? best.endPoint;
  const endAngle = snapped
    ? Math.atan2(endPoint.y - Oy, endPoint.x - Ox)
    : best.endAngle;

  const worldStart = plane.localToWorld(startPoint);
  const worldEnd = plane.localToWorld(endPoint);

  let edge: Edge;
  if (snapped) {
    // The snapped endpoint sits slightly off the solved tangent circle, so
    // refit the arc through the exact endpoints (mid point of the solved
    // sweep as the third point) — exact closure over exact tangency.
    const midAngle = startAngle + best.sweep / 2;
    const midPoint = new Point2D(Ox + radius * Math.cos(midAngle), Oy + radius * Math.sin(midAngle));
    const arc = Geometry.makeArcThreePoints(worldStart, plane.localToWorld(midPoint), worldEnd);
    edge = Geometry.makeEdgeFromCurve(arc);
  } else {
    const normal = ccw ? plane.normal : plane.normal.negate();
    const worldCenter = plane.localToWorld(center);
    const arc = Geometry.makeArc(worldCenter, radius, normal, worldStart, worldEnd);
    edge = Geometry.makeEdgeFromCurve(arc);
  }

  const sign = ccw ? 1 : -1;
  const endTangent = new Point2D(
    sign * (-Math.sin(endAngle)),
    sign * Math.cos(endAngle)
  );

  return { edges: [edge], endTangent };
}

/** The target edge vertex within snap tolerance of the solved end, if any. */
function snapToTargetVertex(
  plane: Plane,
  endPoint: Point2D,
  target: QualifiedShape
): Point2D | null {
  const shape = target.shape;
  if (!(shape instanceof Edge)) {
    return null;
  }

  // A closed target (full circle) has no real endpoints — only a seam vertex.
  if (EdgeQuery.isEdgeClosedCurve(shape)) {
    return null;
  }

  let bestVertex: Point2D | null = null;
  let bestDistance = ENDPOINT_SNAP_TOLERANCE;
  for (const vertex of [shape.getFirstVertex(), shape.getLastVertex()]) {
    const point = plane.worldToLocal(vertex.toPoint());
    const distance = point.distanceTo(endPoint);
    if (distance > EPS && distance <= bestDistance) {
      bestDistance = distance;
      bestVertex = point;
    }
  }
  return bestVertex;
}

function extractTargetGeometry(plane: Plane, target: QualifiedShape): TargetGeom {
  const oc = getOC();
  const shape = target.shape;
  if (!(shape instanceof Edge)) {
    throw new Error('tArc(radius, target): target must be a line, circle, or arc edge');
  }
  const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
  const type = adaptor.GetType();

  if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
    adaptor.delete();
    const start = plane.worldToLocal(shape.getFirstVertex().toPoint());
    const end = plane.worldToLocal(shape.getLastVertex().toPoint());
    const diff = end.subtract(start);
    const len = diff.length();
    if (len < EPS) {
      throw new Error('tArc(radius, target): target line has zero length');
    }
    return {
      type: 'line',
      pointOnLine: start,
      direction: diff.multiplyScalar(1 / len)
    };
  }

  if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const circle = adaptor.Circle();
    const r = circle.Radius();
    const cWorld = Convert.toPoint(circle.Location());
    adaptor.delete();
    return {
      type: 'circle',
      center: plane.worldToLocal(cWorld),
      radius: r
    };
  }

  adaptor.delete();
  throw new Error('tArc(radius, target): target must be a line, circle, or arc');
}

function findIntersections(
  center: Point2D,
  radius: number,
  target: TargetGeom
): Point2D[] {
  if (target.type === 'line') {
    return lineCircleIntersections(center, radius, target.pointOnLine, target.direction);
  }
  return circleCircleIntersections(center, radius, target.center, target.radius);
}

function lineCircleIntersections(
  O: Point2D,
  radius: number,
  Q_L: Point2D,
  d_L: Point2D
): Point2D[] {
  // Line unit normal (rotate direction +90° CCW).
  const nx = -d_L.y;
  const ny = d_L.x;
  const d_OL = (O.x - Q_L.x) * nx + (O.y - Q_L.y) * ny;
  const absD = Math.abs(d_OL);
  if (absD > radius + EPS) { return []; }
  // Foot of perpendicular from O onto the line.
  const Fx = O.x - d_OL * nx;
  const Fy = O.y - d_OL * ny;
  const inside = Math.max(radius * radius - d_OL * d_OL, 0);
  const h = Math.sqrt(inside);
  if (h < EPS) {
    return [new Point2D(Fx, Fy)];
  }
  return [
    new Point2D(Fx + h * d_L.x, Fy + h * d_L.y),
    new Point2D(Fx - h * d_L.x, Fy - h * d_L.y)
  ];
}

function circleCircleIntersections(
  O: Point2D,
  r1: number,
  Cc: Point2D,
  r2: number
): Point2D[] {
  const dx = Cc.x - O.x;
  const dy = Cc.y - O.y;
  const d2 = dx * dx + dy * dy;
  const d = Math.sqrt(d2);
  if (d < EPS) { return []; }
  if (d > r1 + r2 + EPS) { return []; }
  if (d < Math.abs(r1 - r2) - EPS) { return []; }
  const a = (d2 + r1 * r1 - r2 * r2) / (2 * d);
  const inside = Math.max(r1 * r1 - a * a, 0);
  const h = Math.sqrt(inside);
  // Midpoint M = O + (a/d) * (Cc - O).
  const Mx = O.x + (a / d) * dx;
  const My = O.y + (a / d) * dy;
  if (h < EPS) {
    return [new Point2D(Mx, My)];
  }
  // Perpendicular (unit) to (Cc - O).
  const px = -dy / d;
  const py = dx / d;
  return [
    new Point2D(Mx + h * px, My + h * py),
    new Point2D(Mx - h * px, My - h * py)
  ];
}
