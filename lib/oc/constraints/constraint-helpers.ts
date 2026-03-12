import type { GccEnt_Position, gp_Circ, gp_Circ2d, gp_Lin, gp_Lin2d, gp_Pln, gp_Pnt, gp_Pnt2d, Handle_Geom_Curve } from "occjs-wrapper";
import { getOC } from "../init.js";
import { ConstraintQualifier } from "../../features/2d/constraints/qualified-geometry.js";
import { Point2D } from "../../math/point.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Convert } from "../convert.js";
import { Geometry } from "../geometry.js";

export function get2dGeometry<T extends gp_Circ | gp_Lin | gp_Pnt>(plane: gp_Pln, geometry: T): gp_Lin2d | gp_Circ2d | gp_Pnt2d {
  const oc = getOC();
  return oc.ProjLib.Project(plane, geometry as any);
}

export function get2dCurve(plane: gp_Pln, curve: Handle_Geom_Curve) {
  const oc = getOC();
  return oc.GeomAPI.To2d(curve, plane);
}

export function getQualifier(qualifier: ConstraintQualifier): GccEnt_Position {
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

export function getQualifiedCurve(plane: gp_Pln, curve: Handle_Geom_Curve, qualifier: ConstraintQualifier) {
  const oc = getOC();
  const curve2dHandle = get2dCurve(plane, curve);
  const handle = new oc.Geom2dAdaptor_Curve(curve2dHandle);
  return new oc.Geom2dGcc_QualifiedCurve(handle, getQualifier(qualifier));
}

export function getQualifiedGeometry(plane: gp_Pln, geometry: gp_Circ | gp_Lin, qualifier: ConstraintQualifier) {
  const oc = getOC();

  const geom = get2dGeometry<typeof geometry>(plane, geometry);
  if (geom instanceof oc.gp_Circ2d) {
    return new oc.GccEnt_QualifiedCirc(geom, getQualifier(qualifier));
  }
  else if (geom instanceof oc.gp_Lin2d) {
    return new oc.GccEnt_QualifiedLin(geom, getQualifier(qualifier));
  }

  throw new Error('Unsupported geometry type');
}
export function calculateTangent(solutions: {
  center: gp_Pnt2d;
  radius: number;
  tangentPoint1: gp_Pnt2d;
  tangentPoint2: gp_Pnt2d;
}[]): Point2D | null {
  if (solutions.length === 0) {
    return null;
  }

  const lastSolution = solutions[solutions.length - 1];
  const cx = lastSolution.center.X();
  const cy = lastSolution.center.Y();
  const radius = lastSolution.radius;

  let angle1 = Math.atan2(lastSolution.tangentPoint1.Y() - cy, lastSolution.tangentPoint1.X() - cx);
  let angle2 = Math.atan2(lastSolution.tangentPoint2.Y() - cy, lastSolution.tangentPoint2.X() - cx);

  const dist1 = Math.hypot(lastSolution.tangentPoint1.X() - cx, lastSolution.tangentPoint1.Y() - cy);
  const dist2 = Math.hypot(lastSolution.tangentPoint2.X() - cx, lastSolution.tangentPoint2.Y() - cy);
  if (dist1 < radius) { angle1 += Math.PI; }
  if (dist2 < radius) { angle2 += Math.PI; }

  let diff = angle2 - angle1;
  if (diff > Math.PI) { diff -= 2 * Math.PI; }
  if (diff < -Math.PI) { diff += 2 * Math.PI; }

  // Determine whether the actual arc takes the short or long path, using the
  // same heuristic as toArcEdges: pick the arc whose midpoint is closest to
  // the midpoint of the original (raw) tangent points on the input geometries.
  const rawMidX = (lastSolution.tangentPoint1.X() + lastSolution.tangentPoint2.X()) / 2;
  const rawMidY = (lastSolution.tangentPoint1.Y() + lastSolution.tangentPoint2.Y()) / 2;

  const midAngleShort = angle1 + diff / 2;
  const midAngleLong = midAngleShort + Math.PI;

  const shortMidX = cx + radius * Math.cos(midAngleShort);
  const shortMidY = cy + radius * Math.sin(midAngleShort);
  const longMidX = cx + radius * Math.cos(midAngleLong);
  const longMidY = cy + radius * Math.sin(midAngleLong);

  const distShort = Math.hypot(shortMidX - rawMidX, shortMidY - rawMidY);
  const distLong = Math.hypot(longMidX - rawMidX, longMidY - rawMidY);

  // If the long arc is chosen, the traversal direction is opposite to what
  // the short-arc diff implies, so flip the sign.
  const sign = (distShort <= distLong ? diff : -diff) > 0 ? 1 : -1;
  return new Point2D(
    sign * (-Math.sin(angle2)),
    sign * Math.cos(angle2)
  );
}

export function toCircleEdges(solutions: {
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

export function toArcEdges(solutions: {
  center: gp_Pnt2d;
  radius: number;
  tangentPoint1: gp_Pnt2d;
  tangentPoint2: gp_Pnt2d;
}[], plane: Plane): Edge[] {
  return solutions.map(solution => {
    const pnt1 = Convert.toPoint2D(solution.tangentPoint1);
    const pnt2 = Convert.toPoint2D(solution.tangentPoint2);
    const center = Convert.toPoint2D(solution.center);
    const radius = solution.radius;

    let angle1 = Math.atan2(pnt1.y - center.y, pnt1.x - center.x);
    let angle2 = Math.atan2(pnt2.y - center.y, pnt2.x - center.x);

    // Solver tangent points lie on the input geometries, not on the solution
    // circle. When a tangent point falls inside the solution circle (internal
    // tangency), its direction from the center is opposite to the actual
    // tangent point on the solution circle — correct by flipping the angle.
    if (pnt1.distanceTo(center) < radius) { angle1 += Math.PI; }
    if (pnt2.distanceTo(center) < radius) { angle2 += Math.PI; }

    const worldPnt1 = plane.localToWorld(new Point2D(
      center.x + radius * Math.cos(angle1),
      center.y + radius * Math.sin(angle1)
    ));
    const worldPnt2 = plane.localToWorld(new Point2D(
      center.x + radius * Math.cos(angle2),
      center.y + radius * Math.sin(angle2)
    ));

    let diff = angle2 - angle1;
    if (diff > Math.PI) { diff -= 2 * Math.PI; }
    if (diff < -Math.PI) { diff += 2 * Math.PI; }

    const midAngleShort = angle1 + diff / 2;
    const midAngleLong = midAngleShort + Math.PI;

    // Pick the arc whose midpoint is closest to the midpoint of the original
    // tangent points (on the input geometries), so the arc bridges between them.
    const rawMidX = (pnt1.x + pnt2.x) / 2;
    const rawMidY = (pnt1.y + pnt2.y) / 2;

    const shortMidX = center.x + radius * Math.cos(midAngleShort);
    const shortMidY = center.y + radius * Math.sin(midAngleShort);
    const longMidX = center.x + radius * Math.cos(midAngleLong);
    const longMidY = center.y + radius * Math.sin(midAngleLong);

    const distShort = Math.hypot(shortMidX - rawMidX, shortMidY - rawMidY);
    const distLong = Math.hypot(longMidX - rawMidX, longMidY - rawMidY);

    const midAngle = distShort <= distLong ? midAngleShort : midAngleLong;
    const worldMid = plane.localToWorld(new Point2D(
      center.x + radius * Math.cos(midAngle),
      center.y + radius * Math.sin(midAngle)
    ));

    const arc = Geometry.makeArcThreePoints(worldPnt1, worldMid, worldPnt2);
    return Geometry.makeEdgeFromCurve(arc);
  });
}
