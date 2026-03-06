import type { BRepAdaptor_Curve, GccEnt_Position, GccEnt_QualifiedCirc, GccEnt_QualifiedLin, Geom2dGcc_QualifiedCurve, gp_Circ, gp_Lin, gp_Pln, gp_Pnt, Handle_Geom_Curve, TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point } from "../math/point.js";
import { ConstraintQualifier, QualifiedGeometry } from "../features/2d/constraints/qualified-geometry.js";
import { Shape } from "../common/shape.js";
import { Geometry } from "./geometry.js";
import { instance } from "three/tsl";
import { Wire } from "../common/wire.js";

export type ResolvedGeometry =
  | { type: 'circle'; qualified: GccEnt_QualifiedCirc }
  | { type: 'line'; qualified: GccEnt_QualifiedLin }
  | { type: 'curve'; qualified: Geom2dGcc_QualifiedCurve }
  | { type: 'point'; qualified: gp_Pnt };

export class ConstraintResolver {
  static get2dLineRaw(plane: gp_Pln, geometry: gp_Lin) {
    const oc = getOC();
    return oc.ProjLib.Project(plane, geometry);
  }

  static get2dCircleRaw(plane: gp_Pln, geometry: gp_Circ) {
    const oc = getOC();
    return oc.ProjLib.Project(plane, geometry);
  }

  static get2dCurveRaw(plane: gp_Pln, curveHandle: Handle_Geom_Curve) {
    const oc = getOC();
    return oc.GeomAPI.To2d(curveHandle, plane);
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

  static getQualifiedCurve(plane: gp_Pln, shape: Shape, qualifiedGeometry: QualifiedGeometry): ResolvedGeometry {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const type = adaptor.GetType();

    if (type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
      console.log('Ellipse curves are not supported for constraints');
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_BezierCurve) {
      console.log('Bezier curves are not supported for constraints');
    }
    else if (type === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) {
      console.log('BSpline curves are not supported for constraints');
    }

    if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      console.log('Resolving circle curve for constraint');
      if (adaptor.IsClosed()) {
        console.log('Resolving circle curve for constraint');
        const circle = adaptor.Circle();
        adaptor.delete();

        const c1 = ConstraintResolver.get2dCircleRaw(plane, circle);
        circle.delete();

        const qualifier = ConstraintResolver.getQualifier(qualifiedGeometry.qualifier);
        const qualified = new oc.GccEnt_QualifiedCirc(c1, qualifier);

        return { qualified, type: 'circle' };
      } else {
        console.log('Resolving arc curve for constraint');
        const curveAdaptor = adaptor.Curve();
        const curve = curveAdaptor.Curve();
        curveAdaptor.delete();
        adaptor.delete();

        const c1 = ConstraintResolver.get2dCurveRaw(plane, curve);
        const adaptorCurve = new oc.Geom2dAdaptor_Curve(c1);
        const qualifier = ConstraintResolver.getQualifier(qualifiedGeometry.qualifier);
        const qualified = new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);

        return { qualified, type: 'curve' };
      }
    } else if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = adaptor.Line();
      adaptor.delete();

      const l1 = ConstraintResolver.get2dLineRaw(plane, line);
      line.delete();

      const qualifier = ConstraintResolver.getQualifier(qualifiedGeometry.qualifier);
      const qualified = new oc.GccEnt_QualifiedLin(l1, qualifier);

      return { qualified, type: 'line' };
    }

    throw new Error('Unsupported curve type for constraint');
  }

  static getQualified(plane: gp_Pln, qualifiedGeometry: QualifiedGeometry): ResolvedGeometry {
    let shape = qualifiedGeometry.object.getShapes(false)[0];

    console.log('Resolving qualified geometry for shape type:', shape.getType());

    if (shape instanceof Wire) {
      shape = shape.getEdges()[0];
    }

    if (shape.getType() === 'edge') {
      return this.getQualifiedCurve(plane, shape, qualifiedGeometry);
    }

    throw new Error('Unsupported shape type for constraint');
  }

  static getQualifiedAsCurve(plane: gp_Pln, adaptor: BRepAdaptor_Curve, qualifier: ConstraintQualifier): Geom2dGcc_QualifiedCurve {
    const oc = getOC();
    const type = adaptor.GetType();

    if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      if (adaptor.IsClosed()) {
        console.log(':::Converting circle to curve for constraint');
        const circle = adaptor.Circle();
        console.log(':::Got circle from adaptor', circle);
        const circ2d = ConstraintResolver.get2dCircleRaw(plane, circle);
        console.log(':::Got 2D circle from projection', circ2d);
        circle.delete();
        const geom2dCircle = new oc.Geom2d_Circle(circ2d);
        console.log(':::Created 2D circle for constraint', geom2dCircle);
        const handle = new oc.Handle_Geom2d_Curve(geom2dCircle);
        const adaptorCurve = new oc.Geom2dAdaptor_Curve(handle);
        return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
      } else {
        console.log(':::Converting arc to curve for constraint');
        const curveAdaptor = adaptor.Curve();
        const curve = curveAdaptor.Curve();
        curveAdaptor.delete();
        const c2d = ConstraintResolver.get2dCurveRaw(plane, curve);
        const adaptorCurve = new oc.Geom2dAdaptor_Curve(c2d);
        return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
      }
    } else if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = adaptor.Line();
      const lin2d = ConstraintResolver.get2dLineRaw(plane, line);
      line.delete();
      const geom2dLine = new oc.Geom2d_Line(lin2d);
      const handle = new oc.Handle_Geom2d_Curve(geom2dLine);
      const adaptorCurve = new oc.Geom2dAdaptor_Curve(handle);
      return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
    } else {
      const curveAdaptor = adaptor.Curve();
      const curve = curveAdaptor.Curve();
      curveAdaptor.delete();
      const c2d = ConstraintResolver.get2dCurveRaw(plane, curve);
      const adaptorCurve = new oc.Geom2dAdaptor_Curve(c2d);
      return new oc.Geom2dGcc_QualifiedCurve(adaptorCurve, qualifier);
    }
  }
}
