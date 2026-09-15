import type { TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import { EdgeOps } from "../edge-ops.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { mmTol } from "../../units/tolerance.js";

/**
 * A circular arc seen exactly edge-on projects to a straight segment, not to
 * a curve: the whole arc folds onto one line. Neither BRepAlgo_NormalProjection
 * nor ProjLib_ProjectOnPlane nor HLR produce a line for that case — they emit
 * a folded B-spline (start = mid = end for a full circle) that the coincident
 * fuse then drops — so the projection of a cylinder's end circles onto a plane
 * containing its axis silently vanished. This is the analytic rule for it.
 */

export interface EdgeOnCircleArc {
  center: Point;
  /** Unit circle normal. */
  axis: Vector3d;
  /** Unit direction of parameter 0. */
  xDir: Vector3d;
  radius: number;
  /** Parameter range in radians, `first <= last`. */
  first: number;
  last: number;
}

export interface EdgeOnCircleSegment {
  start: Point;
  end: Point;
}

/** An edge's analytic projection: a new edge, or nothing but a point. */
export type ProjectedEdge = { kind: 'edge'; edge: TopoDS_Edge } | { kind: 'point' };

/** Circle normal vs. projection direction: below this the arc is edge-on. */
const EDGE_ON_ANGULAR_TOL = 1e-9;

/**
 * The 3D segment the arc covers when looked at along `direction`, lying in
 * the arc's own plane through its center (the caller projects the two
 * endpoints onto the target plane). Null when the arc is not edge-on.
 */
export function edgeOnCircleSegment(arc: EdgeOnCircleArc, direction: Vector3d): EdgeOnCircleSegment | null {
  const d = direction.normalize();
  if (Math.abs(arc.axis.dot(d)) > EDGE_ON_ANGULAR_TOL) {
    return null;
  }
  // In-plane direction perpendicular to the view: the fold line.
  const t = arc.axis.cross(d).normalize();
  const yDir = arc.axis.cross(arc.xDir);
  const thetaT = Math.atan2(t.dot(yDir), t.dot(arc.xDir));
  const along = (theta: number) => arc.radius * Math.cos(theta - thetaT);

  let min = Math.min(along(arc.first), along(arc.last));
  let max = Math.max(along(arc.first), along(arc.last));
  // Interior extrema of cos(theta - thetaT): theta = thetaT + k*pi.
  const firstK = Math.ceil((arc.first - thetaT) / Math.PI - 1e-9);
  const lastK = Math.floor((arc.last - thetaT) / Math.PI + 1e-9);
  for (let k = firstK; k <= lastK; k++) {
    const value = along(thetaT + k * Math.PI);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    start: arc.center.add(t.multiply(min)),
    end: arc.center.add(t.multiply(max)),
  };
}

export class EdgeOnCircle {
  /**
   * The line edge an edge-on circle or arc projects to on `plane` (or the
   * point it folds to), null when `edge` is not a circle seen edge-on.
   */
  static projectRaw(edge: TopoDS_Edge, plane: Plane): ProjectedEdge | null {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    try {
      if (adaptor.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Circle) {
        return null;
      }
      const circle = adaptor.Circle();
      const axisAx1 = circle.Axis();
      const xAx1 = circle.XAxis();
      const arc: EdgeOnCircleArc = {
        center: Convert.toPoint(circle.Location(), true),
        axis: Convert.toVector3dFromGpDir(axisAx1.Direction(), true),
        xDir: Convert.toVector3dFromGpDir(xAx1.Direction(), true),
        radius: circle.Radius(),
        first: adaptor.FirstParameter(),
        last: adaptor.LastParameter(),
      };
      axisAx1.delete();
      xAx1.delete();
      circle.delete();

      const segment = edgeOnCircleSegment(arc, plane.normal);
      if (!segment) {
        return null;
      }
      const start = plane.projectPoint(segment.start);
      const end = plane.projectPoint(segment.end);
      if (start.distanceTo(end) < mmTol(1e-6)) {
        return { kind: 'point' };
      }
      return { kind: 'edge', edge: EdgeOps.makeLineEdge(start, end).getShape() as TopoDS_Edge };
    } finally {
      adaptor.delete();
    }
  }
}
