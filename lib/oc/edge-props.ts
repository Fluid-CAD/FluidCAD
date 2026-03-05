import type { TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";

export interface EdgeProperties {
  curveType: 'line' | 'circle' | 'arc' | 'ellipse' | 'other';
  length?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
}

export class EdgeProps {
  static getProperties(edge: TopoDS_Shape): EdgeProperties {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);

    const curveType = adaptor.GetType();
    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();

    if (curveType === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const length = Math.abs(last - first);
      adaptor.delete();
      return { curveType: 'line', length };
    }

    if (curveType === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const circle = adaptor.Circle();
      const radius = circle.Radius();
      circle.delete();

      if (adaptor.IsClosed()) {
        adaptor.delete();
        return { curveType: 'circle', radius };
      } else {
        const length = radius * Math.abs(last - first);
        adaptor.delete();
        return { curveType: 'arc', radius, length };
      }
    }

    if (curveType === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
      const ellipse = adaptor.Ellipse();
      const majorRadius = ellipse.MajorRadius();
      const minorRadius = ellipse.MinorRadius();
      ellipse.delete();
      adaptor.delete();
      return { curveType: 'ellipse', majorRadius, minorRadius };
    }

    adaptor.delete();

    // Fallback: use BRepGProp.LinearProperties for length
    const linearProps = new oc.GProp_GProps();
    oc.BRepGProp.LinearProperties(ocEdge, linearProps, false, false);
    const length = linearProps.Mass();
    linearProps.delete();
    return { curveType: 'other', length };
  }
}
