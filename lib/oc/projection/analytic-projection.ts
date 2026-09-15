import type { TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import { EdgeOps } from "../edge-ops.js";
import { ShapeOps } from "../shape-ops.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Matrix4 } from "../../math/matrix4.js";
import { mmTol } from "../../units/tolerance.js";
import { EdgeOnCircle, ProjectedEdge } from "./edge-on-circle.js";

/** Circle normal vs. plane normal: above this the circle is parallel to the plane. */
const PARALLEL_COS_TOL = 1 - 1e-9;

/**
 * Exact projections for the edge kinds that have one, so a projected profile
 * carries the same lines and arcs a hand-drawn one would, not a B-spline fit
 * of them: a line by its endpoints, a circle parallel to the plane by
 * translation, an edge-on circle by its fold segment. Anything else (a tilted
 * circle, a B-spline) answers null and goes to the normal projection.
 */
export class AnalyticEdgeProjection {
  static projectRaw(edge: TopoDS_Edge, plane: Plane): ProjectedEdge | null {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    const curveType = adaptor.GetType();
    try {
      if (curveType === oc.GeomAbs_CurveType.GeomAbs_Line) {
        const wrapped = Edge.fromTopoDSEdge(edge);
        const start = plane.projectPoint(wrapped.getFirstVertex().toPoint());
        const end = plane.projectPoint(wrapped.getLastVertex().toPoint());
        if (start.distanceTo(end) < mmTol(1e-6)) {
          return { kind: 'point' };
        }
        return { kind: 'edge', edge: EdgeOps.makeLineEdge(start, end).getShape() as TopoDS_Edge };
      }

      if (curveType !== oc.GeomAbs_CurveType.GeomAbs_Circle) {
        return null;
      }
      const folded = EdgeOnCircle.projectRaw(edge, plane);
      if (folded) {
        return folded;
      }
      const circle = adaptor.Circle();
      const axisAx1 = circle.Axis();
      const axis = Convert.toVector3dFromGpDir(axisAx1.Direction(), true);
      const center = Convert.toPoint(circle.Location(), true);
      axisAx1.delete();
      circle.delete();
      if (Math.abs(axis.dot(plane.normal)) < PARALLEL_COS_TOL) {
        return null;
      }
      const translation = plane.normal.multiply(-plane.signedDistanceToPoint(center));
      const matrix = Matrix4.fromTranslation(translation.x, translation.y, translation.z);
      const moved = ShapeOps.transform(Edge.fromTopoDSEdge(edge), matrix) as Edge;
      return { kind: 'edge', edge: moved.getShape() as TopoDS_Edge };
    } finally {
      adaptor.delete();
    }
  }
}
