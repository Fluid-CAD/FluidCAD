import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import type { Edge } from "../common/edge.js";
import { CurveClass, CurveClassifier } from "./curve-classifier.js";

export interface EdgeProperties {
  /** The curve's kind; `other` is a hyperbola, a parabola or an offset curve. */
  curveType: 'line' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'other';
  /** The edge returns to its start: a full circle, a full ellipse, a closed spline. */
  closed: boolean;
  /** The edge lies in one plane. */
  planar: boolean;
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
   * predicate it instantiates agree on every edge.
   *
   * Reads the wrapper's kept class; a spline's planarity and a length that
   * needs integrating are computed only when read.
   */
  static of(edge: Edge): EdgeProperties {
    return EdgeProps.fromClass(CurveClassifier.classify(edge));
  }

  /** {@link of} for a raw edge: classified afresh, with every property read at once. */
  static getProperties(edge: TopoDS_Shape): EdgeProperties {
    // Spread out: the properties may outlive the raw edge, which a lazy length or planarity would still read.
    return { ...EdgeProps.fromClass(CurveClassifier.classifyRaw(edge)) };
  }

  /** A curve class as the properties shown for the edge; `planar` and `length` are read off the class on demand. */
  private static fromClass(curve: CurveClass): EdgeProperties {
    const closed = curve.closed;
    switch (curve.kind) {
      case 'line':
        return { curveType: 'line', closed, get planar() { return curve.planar; }, get length() { return curve.length; } };
      case 'circle':
        return { curveType: 'circle', closed, get planar() { return curve.planar; }, radius: curve.radius };
      case 'arc':
        return { curveType: 'arc', closed, get planar() { return curve.planar; }, radius: curve.radius, get length() { return curve.length; } };
      case 'ellipse':
        return {
          curveType: 'ellipse', closed, get planar() { return curve.planar; },
          majorRadius: curve.majorRadius, minorRadius: curve.minorRadius,
        };
      default:
        return { curveType: curve.kind, closed, get planar() { return curve.planar; }, get length() { return curve.length; } };
    }
  }
}
