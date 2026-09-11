import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Vector3d } from "../math/vector3d.js";
import { TopologyIndex } from "./topology-index.js";
import { Solid } from "../common/solid.js";
import { Edge } from "../common/edge.js";

/**
 * How a solid sits around one of its edges: an outer corner (`convex`), an
 * inner corner (`concave`), or no corner at all (`smooth` — the two faces
 * are tangent there, as at a fillet's boundary).
 */
export type EdgeConvexity = 'convex' | 'concave' | 'smooth';

/** Faces closer than this in normal are tangent — unit: dimensionless (cosine). */
const SMOOTH_COSINE = 1 - 1e-6;

export class EdgeConvexityOps {
  /**
   * Classify `edge` within `solid`, or null when the solid does not own the
   * edge with exactly two faces (a seam, a sheet border, foreign geometry).
   *
   * With outward normals n1, n2 of the two faces at the edge midpoint and
   * the edge's tangent t oriented as face 1's wire traverses it (material
   * on the left, per OCCT's wire convention), the corner is convex when
   * (n1 × n2) · t > 0 and concave when it is negative.
   */
  static classify(edge: Edge, solid: Solid): EdgeConvexity | null {
    const raw = edge.getShape() as TopoDS_Edge;
    const faces = TopologyIndex.seekShapes(solid.getEdgeToFacesIndex(), raw);
    if (faces.length !== 2) {
      return null;
    }
    return EdgeConvexityOps.classifyRaw(raw, faces[0], faces[1]);
  }

  static classifyRaw(edge: TopoDS_Edge, face1: TopoDS_Shape, face2: TopoDS_Shape): EdgeConvexity | null {
    const oc = getOC();
    const n1 = EdgeConvexityOps.outwardNormalAt(edge, face1);
    const n2 = EdgeConvexityOps.outwardNormalAt(edge, face2);
    if (!n1 || !n2) {
      return null;
    }
    if (n1.dot(n2) > SMOOTH_COSINE) {
      return 'smooth';
    }

    const sign = EdgeConvexityOps.orientationIn(edge, face1);
    if (sign === 0) {
      return null;
    }
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    const tangent = new oc.gp_Vec();
    const point = new oc.gp_Pnt();
    try {
      const mid = (adaptor.FirstParameter() + adaptor.LastParameter()) / 2;
      adaptor.D1(mid, point, tangent);
      const t = Convert.toVector3d(tangent).normalize().multiply(sign);
      const turn = n1.cross(n2).dot(t);
      if (Math.abs(turn) < 1e-9) {
        return 'smooth';
      }
      return turn > 0 ? 'convex' : 'concave';
    } finally {
      point.delete();
      tangent.delete();
      adaptor.delete();
    }
  }

  /** The face's outward normal at the edge's midpoint (see `FaceOps.outwardNormalOnEdge`). */
  private static outwardNormalAt(edge: TopoDS_Edge, face: TopoDS_Shape): Vector3d | null {
    const oc = getOC();
    return FaceOps.outwardNormalOnEdge(oc.TopoDS.Face(face), edge);
  }

  /**
   * +1 when the face's wire traverses the edge forward, −1 when reversed,
   * 0 when the face does not contain it. The explorer composes the face's
   * own orientation into each edge it yields, so a reversed face in the
   * solid reports its edges the way the outward-facing wire runs them.
   */
  private static orientationIn(edge: TopoDS_Edge, face: TopoDS_Shape): number {
    const oc = getOC();
    const explorer = new oc.TopExp_Explorer(
      face, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum,
    );
    try {
      while (explorer.More()) {
        const current = explorer.Current();
        if (current.IsSame(edge)) {
          return current.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
        }
        explorer.Next();
      }
      return 0;
    } finally {
      explorer.delete();
    }
  }
}
