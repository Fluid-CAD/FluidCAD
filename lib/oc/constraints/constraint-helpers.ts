import type { GccEnt_Position, gp_Circ, gp_Circ2d, gp_Lin, gp_Lin2d, gp_Pln, gp_Pnt, gp_Pnt2d, Handle_Geom_Curve, TopoDS_Shape, TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "../init.js";
import { ConstraintQualifier } from "../../features/2d/constraints/qualified-geometry.js";

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

export function getQualified(plane: gp_Pln, geometry: gp_Circ | gp_Lin, qualifier: ConstraintQualifier) {
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
