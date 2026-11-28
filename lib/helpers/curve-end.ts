import type { TopoDS_Edge } from "ocjs-fluidcad";
import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { BuildError } from "../common/build-error.js";
import { AnchoredLazyVertex } from "../features/anchored-vertex.js";
import { LazyVertex } from "../features/lazy-vertex.js";
import { PointResolver } from "../features/point-resolver.js";
import { SketchPointVertex } from "../features/sketch-point-ref.js";
import { OffsetEdgePointRef } from "../features/2d/offset-edge.js";
import { SolvedPoint } from "../features/2d/solved/point.js";
import { anchorEndParameter, anchorFromShape } from "../features/shape-anchor.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { getOC } from "../oc/init.js";
import { mmTol } from "../units/tolerance.js";

/** A curve end as a bridge sees it. */
export type CurveEnd = {
  point: Point;
  /** Unit direction the curve is heading as it leaves through this end. Absent for a bare point. */
  tangent?: Vector3d;
  /** Curvature vector there (towards the centre of curvature, length 1/radius). Absent for a bare point. */
  curvature?: Vector3d;
};

/** One of an edge's two ends, in the edge's own sense (`.start()` / `.end()`, see `anchorFromShape`). */
export type EdgeEnd = 'start' | 'end';

/** The refusal of a value that is neither the end of an edge nor a point. */
function notAnEnd(): BuildError {
  return new BuildError(
    `bridge: an end is the start or the end of an edge, or a point.`,
    `Take .start() or .end() of an edge or a curve (c.end(), e.sideEdges(2).start()), or give a vertex or a sketch point.`,
  );
}

/**
 * Reads a curve end — what a bridge (and later a fill guide or a match
 * curve) needs at the place it meets a curve: the point, and, where it is
 * the end of an edge, the way the edge leaves through it and how it bends
 * there.
 *
 * What names the end of an edge:
 *
 * - `.start()` or `.end()` of an edge selection (`e.sideEdges(2).end()`,
 *   `c.edges(0).start()`, `select(edge()…).end()`): that end of the
 *   selection's first edge, in the edge's own sense;
 * - `.start()` or `.end()` of a curve object (`c.end()`): where the curve
 *   starts or ends, on its first or last edge, whichever way that edge's
 *   curve runs;
 * - a point of a sketch entity that is an end of one of the entity's edges
 *   (`sk.geometries.l.start()` on a line, `bz.point(0)`, `o.edge(2).end()`).
 *
 * Anything else that is a point — a sketch point (`sk.geometries.p`, or
 * its `.start()`), a centre, a plain vertex — is a bare point: position
 * only. `.center()`, `.offset(…)` or an anchor
 * on a face is refused.
 *
 * The tangent always points **out of** the curve: at the curve's last
 * parameter along the first derivative, at its first against it. That is
 * the edge's geometry, whatever the edge's orientation or the way a wire
 * walks it, so the end of a reversed edge and the start of a curve whose
 * edges run against the wire read the same way. The curvature vector does
 * not depend on the direction of travel.
 */
export class CurveEnds {

  /** The end `value` names: see the class comment. A BuildError for a value that is no end. */
  static read(value: SceneObject): CurveEnd {
    if (value instanceof AnchoredLazyVertex) {
      const spec = value.getAnchorSpec();
      if (spec.kind !== 'start' && spec.kind !== 'end') {
        throw notAnEnd();
      }
      let shape;
      try {
        shape = value.getAnchorShape();
      } catch {
        throw notAnEnd();
      }
      if (shape instanceof Face || !(shape instanceof Edge)) {
        throw notAnEnd();
      }
      return CurveEnds.ofEdge(shape, spec.kind);
    }
    const ref = value instanceof SolvedPoint ? value.start() : value;
    if (ref instanceof SketchPointVertex) {
      const point = PointResolver.toWorld(ref);
      const at = CurveEnds.edgeEndAt(CurveEnds.entityEdges(ref), point, ref.role);
      return at ? CurveEnds.ofEdge(at.edge, at.end) : { point };
    }
    if (ref instanceof LazyVertex) {
      return { point: PointResolver.toWorld(ref) };
    }
    throw notAnEnd();
  }

  /**
   * One end of an edge: the point of its curve at that end, the unit first
   * derivative turned to point out of the edge, and the curvature vector
   * `(D2 − (D2 · t) t) / |D1|²`, `t` the unit first derivative. `end` is in
   * the edge's own sense, as `.start()` / `.end()` read it.
   */
  static ofEdge(edge: Edge, end: EdgeEnd): CurveEnd {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge.getShape() as TopoDS_Edge);
    const pnt = new oc.gp_Pnt();
    const d1 = new oc.gp_Vec();
    const d2 = new oc.gp_Vec();
    try {
      const { parameter, last } = anchorEndParameter(adaptor, end);
      adaptor.D2(parameter, pnt, d1, d2);
      const point = new Point(pnt.X(), pnt.Y(), pnt.Z());
      const first = new Vector3d(d1.X(), d1.Y(), d1.Z());
      const second = new Vector3d(d2.X(), d2.Y(), d2.Z());
      const speed = first.length();
      // unit: dimensionless — a derivative this small leaves the direction undefined.
      if (speed < 1e-12) {
        throw new BuildError(
          `bridge: the curve has no direction at one of the ends.`,
          `Take the end of another edge, or give a point.`,
        );
      }
      const t = first.divide(speed);
      const curvature = second.subtract(t.multiply(second.dot(t))).divide(speed * speed);
      return { point, tangent: last ? t : t.negate(), curvature };
    } finally {
      d2.delete();
      d1.delete();
      pnt.delete();
      adaptor.delete();
    }
  }

  /**
   * The edges a sketch point can be an end of: the one edge of an offset
   * edge's point (`o.edge(2).start()`), else every edge the point's entity
   * built (still read when a later statement consumed the sketch).
   */
  private static entityEdges(ref: SketchPointVertex): Edge[] {
    if (ref instanceof OffsetEdgePointRef) {
      return ref.edge.offsetOwner.edgeShapes(ref.edgeIndex);
    }
    return ref.owner.getAddedShapes().filter((shape): shape is Edge => shape instanceof Edge && !shape.isMetaShape());
  }

  /**
   * The edge `point` is an end of, and which end in the edge's own sense:
   * when exactly one of `edges` ends there. A closed edge ends there both
   * ways; the point's role says which (`end`, or the start otherwise). Null
   * when no edge, or more than one, ends at the point: a centre, a point
   * entity, a corner two edges share.
   */
  private static edgeEndAt(edges: Edge[], point: Point, role: string): { edge: Edge; end: EdgeEnd } | null {
    const tolerance = mmTol(1e-6);
    const found: { edge: Edge; end: EdgeEnd }[] = [];
    for (const edge of edges) {
      const ends = (['start', 'end'] as const).filter(end => anchorFromShape(edge, { kind: end }).origin.distanceTo(point) <= tolerance);
      if (ends.length === 1) {
        found.push({ edge, end: ends[0] });
      } else if (ends.length === 2) {
        found.push({ edge, end: role === 'end' ? 'end' : 'start' });
      }
    }
    return found.length === 1 ? found[0] : null;
  }
}
