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
  const angle1 = Math.atan2(lastSolution.tangentPoint1.Y() - lastSolution.center.Y(), lastSolution.tangentPoint1.X() - lastSolution.center.X());
  const angle2 = Math.atan2(lastSolution.tangentPoint2.Y() - lastSolution.center.Y(), lastSolution.tangentPoint2.X() - lastSolution.center.X());

  let diff = angle2 - angle1;
  if (diff > Math.PI) { diff -= 2 * Math.PI; }
  if (diff < -Math.PI) { diff += 2 * Math.PI; }

  const sign = diff > 0 ? 1 : -1;
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
