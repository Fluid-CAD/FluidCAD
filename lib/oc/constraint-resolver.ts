import type { BRepAdaptor_Curve, GccEnt_Position, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, Geom2d_Curve, Geom2dGcc_QualifiedCurve, gp_Circ, gp_Circ2d, gp_Lin, gp_Lin2d, gp_Pln, gp_Pnt, gp_Pnt2d, Handle_Geom_Curve, TopoDS_Shape, TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point } from "../math/point.js";
import { ConstraintQualifier, QualifiedGeometry } from "../features/2d/constraints/qualified-geometry.js";
import { Shape } from "../common/shape.js";
import { Geometry } from "./geometry.js";
import { instance } from "three/tsl";
import { Wire } from "../common/wire.js";

export class ConstraintResolver {
  static get2dGeometry<T extends gp_Circ | gp_Lin | gp_Pnt>(plane: gp_Pln, geometry: T): gp_Lin2d | gp_Circ2d | gp_Pnt2d {
    const oc = getOC();
    return oc.ProjLib.Project(plane, geometry as any);
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

  static getQualified(plane: gp_Pln, geometry: gp_Circ | gp_Lin, qualifier: ConstraintQualifier) {
    const oc = getOC();

    const geom = this.get2dGeometry<typeof geometry>(plane, geometry);
    if (geom instanceof oc.gp_Circ2d) {
      return new oc.GccEnt_QualifiedCirc(geom, this.getQualifier(qualifier));
    }
    else if (geom instanceof oc.gp_Lin2d) {
      return new oc.GccEnt_QualifiedLin(geom, this.getQualifier(qualifier));
    }

    throw new Error('Unsupported geometry type');
  }
}
