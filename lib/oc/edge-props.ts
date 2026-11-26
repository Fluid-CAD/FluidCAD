import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { CurveClass, CurveClassifier } from "./curve-classifier.js";

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

  /**
   * The edge's kind and sizes, read off its {@link CurveClassifier} class —
   * the classification the edge filters read too, so a probe and the
   * predicate it instantiates agree on every edge. A spline is `other`.
   */
  static getProperties(edge: TopoDS_Shape): EdgeProperties {
    return EdgeProps.fromClass(CurveClassifier.classifyRaw(edge));
  }

  /** A curve class as the properties shown for the edge. */
  static fromClass(curve: CurveClass): EdgeProperties {
    switch (curve.kind) {
      case 'line':
        return { curveType: 'line', length: curve.length };
      case 'circle':
        return { curveType: 'circle', radius: curve.radius };
      case 'arc':
        return { curveType: 'arc', radius: curve.radius, length: curve.length };
      case 'ellipse':
        return { curveType: 'ellipse', majorRadius: curve.majorRadius, minorRadius: curve.minorRadius };
      default:
        return { curveType: 'other', length: curve.length };
    }
  }
}
