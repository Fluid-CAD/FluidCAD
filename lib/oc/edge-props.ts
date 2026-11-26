import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { EdgeQuery } from "./edge-query.js";

export interface EdgeProperties {
  curveType: 'line' | 'circle' | 'arc' | 'ellipse' | 'other';
  length?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
}

export type EdgeEndpoints = {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
};

export class EdgeProps {
  /**
   * Where an edge starts and ends, in the edge's own direction (a reversed
   * edge starts at its curve's last point). A closed edge — a full circle —
   * starts and ends at the same point.
   */
  static endpoints(edge: TopoDS_Shape): EdgeEndpoints {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const first = oc.TopExp.FirstVertex(ocEdge, true);
    const last = oc.TopExp.LastVertex(ocEdge, true);
    const firstPnt = oc.BRep_Tool.Pnt(first);
    const lastPnt = oc.BRep_Tool.Pnt(last);
    try {
      return {
        start: { x: firstPnt.X(), y: firstPnt.Y(), z: firstPnt.Z() },
        end: { x: lastPnt.X(), y: lastPnt.Y(), z: lastPnt.Z() },
      };
    } finally {
      firstPnt.delete();
      lastPnt.delete();
      first.delete();
      last.delete();
      ocEdge.delete();
    }
  }

  static getProperties(edge: TopoDS_Shape): EdgeProperties {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);
    // The adaptor holds its own reference to the edge; the typed copy goes.
    ocEdge.delete();

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
    oc.BRepGProp.LinearProperties(edge, linearProps, false, false);
    const length = linearProps.Mass();
    linearProps.delete();

    // A B-spline standing for a line or circular arc (loft sections, fillet
    // rims on a lofted wall) classifies by the geometry it approximates —
    // the same recovery the line()/arc()/circle() filters run, so a probe
    // and the predicate it instantiates agree on every edge.
    const geometry = EdgeQuery.getEdgeGeometryRaw(edge);
    if (geometry.kind === 'line') {
      return { curveType: 'line', length };
    }
    if (geometry.kind === 'circle') {
      return geometry.closed
        ? { curveType: 'circle', radius: geometry.radius }
        : { curveType: 'arc', radius: geometry.radius, length };
    }
    return { curveType: 'other', length };
  }
}
