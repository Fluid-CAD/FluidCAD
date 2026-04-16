import type { TopoDS_Edge, TopoDS_Face } from "occjs-wrapper";
import { getOC } from "../oc/init.js";
import { Shape, Edge, Face } from "../common/shapes.js";

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
   * and their tangent vectors at that vertex are parallel.
   */
  private static expandEdges(seeds: Edge[], pool: Edge[]): Edge[] {
    // Build vertex → edge adjacency map for efficient lookup
    const vertexToEdges = TangentExpander.buildVertexToEdgeMap(pool);

    const included = new Set<Edge>(seeds);
    const queue: Edge[] = [...seeds];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = TangentExpander.getAdjacentEdges(current, vertexToEdges);

      for (const candidate of neighbors) {
        if (included.has(candidate)) {
          continue;
        }
        if (TangentExpander.areEdgesTangent(current, candidate)) {
          included.add(candidate);
          queue.push(candidate);
        }
      }
    }

    return [...included];
  }

  /**
   * BFS expansion for faces. Two faces are tangent if they share an edge
   * and have G1 or higher continuity across that edge.
   */
  private static expandFaces(seeds: Face[], pool: Face[]): Face[] {
    // Build edge → face adjacency map
    const edgeToFaces = TangentExpander.buildEdgeToFaceMap(pool);

    const included = new Set<Face>(seeds);
    const queue: Face[] = [...seeds];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = TangentExpander.getAdjacentFaces(current, edgeToFaces);

      for (const [candidate, sharedEdge] of neighbors) {
        if (included.has(candidate)) {
          continue;
        }
        if (TangentExpander.areFacesTangent(current, candidate, sharedEdge)) {
          included.add(candidate);
          queue.push(candidate);
        }
      }
    }

    return [...included];
  }

  /**
   * Checks if two edges are tangent at a shared vertex by comparing
   * their tangent vectors (parallel = tangent).
   */
  static areEdgesTangent(e1: Edge, e2: Edge): boolean {
    const oc = getOC();
    const angTol = 1e-4;

    const e1Raw = e1.getShape() as TopoDS_Edge;
    const e2Raw = e2.getShape() as TopoDS_Edge;

    const e1First = oc.TopExp.FirstVertex(e1Raw, true);
    const e1Last = oc.TopExp.LastVertex(e1Raw, true);
    const e2First = oc.TopExp.FirstVertex(e2Raw, true);
    const e2Last = oc.TopExp.LastVertex(e2Raw, true);

    // Check all 4 vertex pairings for a shared vertex
    const pairs = [
      { v1: e1First, v2: e2First },
      { v1: e1First, v2: e2Last },
      { v1: e1Last, v2: e2First },
      { v1: e1Last, v2: e2Last },
    ];

    for (const { v1, v2 } of pairs) {
      if (!v1.IsPartner(v2)) {
        continue;
      }

      // Get raw curves and parameters at the shared vertex
      const curve1Handle = oc.BRep_Tool.Curve(e1Raw, 0, 1);
      const curve1 = curve1Handle.get();
      const param1 = oc.BRep_Tool.Parameter(v1, e1Raw);

      const curve2Handle = oc.BRep_Tool.Curve(e2Raw, 0, 1);
      const curve2 = curve2Handle.get();
      const param2 = oc.BRep_Tool.Parameter(v2, e2Raw);

      // Evaluate tangent vectors using D1
      const pnt1 = new oc.gp_Pnt();
      const vec1 = new oc.gp_Vec();
      curve1.D1(param1, pnt1, vec1);

      const pnt2 = new oc.gp_Pnt();
      const vec2 = new oc.gp_Vec();
      curve2.D1(param2, pnt2, vec2);

      // Flip tangent if edge is reversed
      if (e1Raw.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
        vec1.Reverse();
      }
      if (e2Raw.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
        vec2.Reverse();
      }

      // Check parallelism: |cos(angle)| > cos(angTol)
      const mag1 = vec1.Magnitude();
      const mag2 = vec2.Magnitude();
      let tangent = false;

      if (mag1 > 1e-10 && mag2 > 1e-10) {
        const dot = Math.abs(vec1.Normalized().Dot(vec2.Normalized()));
        tangent = dot > Math.cos(angTol);
      }

      // Cleanup
      pnt1.delete();
      vec1.delete();
      pnt2.delete();
      vec2.delete();

      if (tangent) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks if two faces are tangent along a shared edge.
   * Uses BRepLib.ContinuityOfFaces which computes the continuity from geometry
   * on-the-fly (unlike BRep_Tool.Continuity which reads stored flags).
   */
  static areFacesTangent(f1: Face, f2: Face, sharedEdge: TopoDS_Edge): boolean {
    const oc = getOC();
    const f1Raw = f1.getShape() as TopoDS_Face;
    const f2Raw = f2.getShape() as TopoDS_Face;
    const angTol = 0.01; // ~0.57 degrees

    const continuity = oc.BRepLib.ContinuityOfFaces(sharedEdge, f1Raw, f2Raw, angTol);
    // C0 = sharp edge (not tangent). Anything else (G1, C1, G2, C2, C3, CN) = tangent.
    return continuity !== oc.GeomAbs_Shape.GeomAbs_C0;
  }

  /**
   * Builds a map from vertex TShape hash to the list of edges that share that vertex.
   */
  private static buildVertexToEdgeMap(edges: Edge[]): Map<number, Edge[]> {
    const oc = getOC();
    const map = new Map<number, Edge[]>();

    for (const edge of edges) {
      const raw = edge.getShape() as TopoDS_Edge;
      const first = oc.TopExp.FirstVertex(raw, true);
      const last = oc.TopExp.LastVertex(raw, true);

      for (const vertex of [first, last]) {
        const hash = vertex.HashCode(2147483647);
        if (!map.has(hash)) {
          map.set(hash, []);
        }
        map.get(hash)!.push(edge);
      }
    }

    return map;
  }

  /**
   * Builds a map from edge TShape hash to the list of faces that share that edge.
   */
  private static buildEdgeToFaceMap(faces: Face[]): Map<number, Face[]> {
    const map = new Map<number, Face[]>();

    for (const face of faces) {
      const faceEdges = face.getEdges();
      for (const edge of faceEdges) {
        const hash = edge.getShape().HashCode(2147483647);
        if (!map.has(hash)) {
          map.set(hash, []);
        }
        map.get(hash)!.push(face);
      }
    }

    return map;
  }

  /**
   * Returns edges from the adjacency map that share a vertex with the given edge.
   */
  private static getAdjacentEdges(edge: Edge, vertexToEdges: Map<number, Edge[]>): Edge[] {
    const oc = getOC();
    const raw = edge.getShape() as TopoDS_Edge;
    const first = oc.TopExp.FirstVertex(raw, true);
    const last = oc.TopExp.LastVertex(raw, true);

    const neighbors = new Set<Edge>();
    for (const vertex of [first, last]) {
      const hash = vertex.HashCode(2147483647);
      const candidates = vertexToEdges.get(hash);
      if (candidates) {
        for (const c of candidates) {
          if (c !== edge) {
            neighbors.add(c);
          }
        }
      }
    }

    return [...neighbors];
  }

  /**
   * Returns faces from the adjacency map that share an edge with the given face,
   * along with the shared edge's raw TopoDS_Edge.
   */
  private static getAdjacentFaces(face: Face, edgeToFaces: Map<number, Face[]>): Array<[Face, TopoDS_Edge]> {
    const result: Array<[Face, TopoDS_Edge]> = [];
    const faceEdges = face.getEdges();

    for (const edge of faceEdges) {
      const hash = edge.getShape().HashCode(2147483647);
      const candidates = edgeToFaces.get(hash);
      if (candidates) {
        for (const c of candidates) {
          if (c !== face) {
            result.push([c, edge.getShape() as TopoDS_Edge]);
          }
        }
      }
    }

    return result;
  }
}
