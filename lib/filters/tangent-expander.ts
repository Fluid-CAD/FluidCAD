import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex } from "ocjs-fluidcad";
import { getOC } from "../oc/init.js";
import { Shape, Edge, Face } from "../common/shapes.js";
import { Connectivity } from "./connectivity.js";

export class TangentExpander {

  /**
   * Expands a set of seed shapes to include all transitively tangent-connected
   * shapes from the pool. Dispatches to edge or face expansion based on shape type.
   */
  static expand(seeds: Shape[], pool: Shape[]): Shape[] {
    if (seeds.length === 0) {
      return [];
    }

    if (seeds[0].isEdge()) {
      return TangentExpander.expandEdges(seeds as Edge[], pool as Edge[]);
    } else {
      return TangentExpander.expandFaces(seeds as Face[], pool as Face[]);
    }
  }

  /**
   * BFS expansion for edges. Two edges are tangent if they share a vertex
   * and one continues the other smoothly there (see {@link areEdgesTangent}).
   */
  private static expandEdges(seeds: Edge[], pool: Edge[]): Edge[] {
    const connectivity = Connectivity.ofEdges(pool);
    try {
      return connectivity.flood(seeds, (current, candidate) => TangentExpander.areEdgesTangent(current, candidate));
    } finally {
      connectivity.delete();
    }
  }

  /**
   * BFS expansion for faces. Two faces are tangent if they share an edge
   * and have G1 or higher continuity across that edge.
   */
  private static expandFaces(seeds: Face[], pool: Face[]): Face[] {
    const connectivity = Connectivity.ofFaces(pool);
    try {
      return connectivity.flood(seeds, (current, candidate, shared) =>
        TangentExpander.areFacesTangent(current, candidate, shared as TopoDS_Edge));
    } finally {
      connectivity.delete();
    }
  }

  /**
   * Whether two edges continue each other smoothly at a vertex they share.
   * Each edge's tangent is taken in the direction leading **away from** the
   * shared vertex: a smooth continuation has the two pointing opposite ways
   * (one arrives where the other leaves), while two edges that fold straight
   * back onto the same side — a cusp — have them pointing the same way, and
   * are not tangent.
   */
  static areEdgesTangent(e1: Edge, e2: Edge): boolean {
    const oc = getOC();
    // unit: angular (radians) — scale-free
    const angTol = 1e-4;

    const e1Raw = e1.getShape() as TopoDS_Edge;
    const e2Raw = e2.getShape() as TopoDS_Edge;

    // Each edge's ends in its own orientation: the start, where the edge
    // leaves along its tangent, and the end, where it arrives along it.
    const ends1 = [
      { vertex: oc.TopExp.FirstVertex(e1Raw, true), away: 1 },
      { vertex: oc.TopExp.LastVertex(e1Raw, true), away: -1 },
    ];
    const ends2 = [
      { vertex: oc.TopExp.FirstVertex(e2Raw, true), away: 1 },
      { vertex: oc.TopExp.LastVertex(e2Raw, true), away: -1 },
    ];

    try {
      for (const end1 of ends1) {
        for (const end2 of ends2) {
          if (!end1.vertex.IsPartner(end2.vertex)) {
            continue;
          }
          const t1 = TangentExpander.unitTangentAt(e1Raw, end1.vertex);
          const t2 = TangentExpander.unitTangentAt(e2Raw, end2.vertex);
          if (!t1 || !t2) {
            continue;
          }
          const dot = end1.away * end2.away * (t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]);
          if (dot < -Math.cos(angTol)) {
            return true;
          }
        }
      }
      return false;
    } finally {
      for (const { vertex } of [...ends1, ...ends2]) vertex.delete();
    }
  }

  /**
   * The edge's unit tangent at `vertex`, in the direction the oriented edge
   * runs; null where the curve has none (a degenerate edge, a zero derivative).
   */
  private static unitTangentAt(edge: TopoDS_Edge, vertex: TopoDS_Vertex): [number, number, number] | null {
    const oc = getOC();
    const handle = oc.BRep_Tool.Curve(edge, 0, 1);
    const curve = handle?.returnValue;
    if (!curve || curve.isNull()) {
      handle?.[Symbol.dispose]();
      return null;
    }
    const pnt = new oc.gp_Pnt();
    const vec = new oc.gp_Vec();
    try {
      curve.D1(oc.BRep_Tool.Parameter(vertex, edge), pnt, vec);
      const mag = vec.Magnitude();
      if (mag <= 1e-10) {
        return null;
      }
      const sign = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      return [sign * vec.X() / mag, sign * vec.Y() / mag, sign * vec.Z() / mag];
    } finally {
      pnt.delete();
      vec.delete();
      handle[Symbol.dispose]();
    }
  }

  /**
   * Checks if two faces are tangent along a shared edge.
   * Uses BRepLib.ContinuityOfFaces which computes the continuity from geometry
   * on-the-fly (unlike BRep_Tool.Continuity which reads stored flags).
   */
  static areFacesTangent(f1: Face, f2: Face, sharedEdge: TopoDS_Edge | TopoDS_Shape): boolean {
    const oc = getOC();
    const f1Raw = f1.getShape() as TopoDS_Face;
    const f2Raw = f2.getShape() as TopoDS_Face;
    const angTol = 0.01; // ~0.57 degrees

    const continuity = oc.BRepLib.ContinuityOfFaces(sharedEdge as TopoDS_Edge, f1Raw, f2Raw, angTol);
    // C0 = sharp edge (not tangent). Anything else (G1, C1, G2, C2, C3, CN) = tangent.
    return continuity !== oc.GeomAbs_Shape.GeomAbs_C0;
  }
}
