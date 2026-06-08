import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "fluidcad-ocjs";
import { getOC } from "./init.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "./explorer.js";

export interface MeshData {
  vertices: number[];
  normals: number[];
  indices: number[];
  count?: number;
}

export interface MeshConfig {
  linDefl: number;
  angDefl: number;
}

export const DEFAULT_MESH_CONFIG: MeshConfig = {
  linDefl: 0.1,
  angDefl: 0.5,
};

export interface EnsureTriangulatedOptions {
  linDefl?: number;
  angDefl?: number;
  parallel?: boolean;
  relative?: boolean;
  checkFreeEdges?: boolean;
}

export class Mesh {
  // Wrapper methods (public API for external callers)
  static triangulateFace(face: Face, vertexOffset: number = 0, opts?: EnsureTriangulatedOptions): MeshData | null {
    return Mesh.triangulateFaceRaw(face.getShape() as TopoDS_Face, vertexOffset, opts);
  }

  static discretizeEdge(edge: Shape, opts?: EnsureTriangulatedOptions): MeshData {
    return Mesh.discretizeEdgeRaw(edge.getShape(), opts);
  }

  /**
   * Triangulates `shape` only if it doesn't already have an up-to-date
   * triangulation at the requested deflection. Returns true when a fresh
   * mesh was built, false when the stored one was reused.
   */
  static ensureTriangulated(shape: TopoDS_Shape, opts: EnsureTriangulatedOptions = {}): boolean {
    const oc = getOC();
    const linDefl = opts.linDefl ?? DEFAULT_MESH_CONFIG.linDefl;
    const angDefl = opts.angDefl ?? DEFAULT_MESH_CONFIG.angDefl;
    const relative = opts.relative ?? false;
    const checkFreeEdges = opts.checkFreeEdges ?? true;

    if (oc.BRepTools.Triangulation(shape, linDefl, checkFreeEdges)) {
      return false;
    }

    console.log('Triangulating shape of type', Explorer.getShapeType(shape))
    const inc = new oc.BRepMesh_IncrementalMesh(shape, linDefl, relative, angDefl, true);
    inc.delete();
    return true;
  }

  // Raw methods (for oc-internal use)
  static triangulateFaceRaw(face: TopoDS_Face, vertexOffset: number = 0, opts?: EnsureTriangulatedOptions): MeshData | null {
    try {
      Mesh.ensureTriangulated(face, opts);
    } catch (e) {
      console.error("Face mesh failed", e);
      return null;
    }

    return Mesh.extractFaceTriangulationRaw(face, vertexOffset);
  }

  static extractFaceTriangulationRaw(face: TopoDS_Face, vertexOffset: number = 0): MeshData | null {
    const oc = getOC();

    const vertices: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    const aLocation = new oc.TopLoc_Location();
    const triangulation = oc.BRep_Tool.Triangulation(face, aLocation, 0);
    if (triangulation.isNull()) {
      aLocation.delete();
      return null;
    }

    const pc = new oc.Poly_Connect(triangulation);
    const nbNodes = triangulation.NbNodes();

    for (let i = 1; i <= nbNodes; i++) {
      const t1 = aLocation.Transformation();
      const p = triangulation.Node(i);
      const p1 = p.Transformed(t1);
      vertices.push(p1.X(), p1.Y(), p1.Z());
      p.delete();
      p1.delete();
      t1.delete();
    }

    // OCCT 8.0: StdPrs_ToolTriangulatedShape (TKV3d) is gone; the surface-normals
    // utility moved to BRepLib_ToolTriangulatedShape (TKTopAlgo). It computes nodal
    // normals into the triangulation itself (no-op if it already has them), which we
    // then read back via Poly_Triangulation.Normal(i).
    oc.BRepLib_ToolTriangulatedShape.ComputeNormals(face, triangulation, pc);

    // A triangulation stores normals in the natural orientation of the
    // underlying surface, NOT the face's topological orientation. For a
    // TopAbs_REVERSED face the outward normal is the opposite of the surface
    // normal, so we must flip the nodal normals here. (Pre-OCCT-8 this was done
    // internally by StdPrs_ToolTriangulatedShape::Normal; BRepLib_ToolTriangulatedShape
    // ::ComputeNormals does not, which left reversed faces shaded as if lit from
    // inside the solid — they rendered dark.) The triangle winding below is
    // swapped under the same condition so winding and shading normals agree.
    const orient = face.Orientation();
    const reversed = orient !== oc.TopAbs_Orientation.TopAbs_FORWARD;

    for (let i = 1; i <= nbNodes; i++) {
      const t1 = aLocation.Transformation();
      const d1 = triangulation.Normal(i);
      const d = d1.Transformed(t1);
      if (reversed) {
        normals.push(-d.X(), -d.Y(), -d.Z());
      } else {
        normals.push(d.X(), d.Y(), d.Z());
      }
      d1.delete();
      d.delete();
      t1.delete();
    }

    const triangles = triangulation.Triangles();
    for (let nt = 1; nt <= triangulation.NbTriangles(); nt++) {
      const t = triangles.Value(nt);
      let n1 = t.Value(1) - 1;
      let n2 = t.Value(2) - 1;
      let n3 = t.Value(3) - 1;
      if (reversed) {
        [n1, n2] = [n2, n1];
      }
      indices.push(vertexOffset + n1, vertexOffset + n2, vertexOffset + n3);
      t.delete();
    }

    pc.delete();
    triangles.delete();
    triangulation.delete();
    aLocation.delete();

    return { vertices, normals, indices, count: nbNodes };
  }

  /**
   * Reads the polyline stored for `edge` as a polygon-on-triangulation of
   * `face`. Node indices point into the face's triangulation, so the edge
   * samples coincide exactly with the face mesh vertices (watertight).
   */
  static discretizeEdgeOnFace(edge: TopoDS_Edge, face: TopoDS_Face): MeshData | null {
    const oc = getOC();
    if (oc.BRep_Tool.Degenerated(edge)) {
      return null;
    }

    const loc = new oc.TopLoc_Location();
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (tri.isNull()) {
      tri.delete();
      loc.delete();
      return null;
    }

    const poly = oc.BRep_Tool.PolygonOnTriangulation(edge, tri, loc);
    if (poly.isNull()) {
      poly.delete();
      tri.delete();
      loc.delete();
      return null;
    }

    const nbNodes = poly.NbNodes();
    const tx = loc.Transformation();

    const vertices: number[] = new Array(nbNodes * 3);
    for (let i = 1; i <= nbNodes; i++) {
      const nodeIdx = poly.Node(i);
      const p = tri.Node(nodeIdx);
      const pT = p.Transformed(tx);
      const base = (i - 1) * 3;
      vertices[base] = pT.X();
      vertices[base + 1] = pT.Y();
      vertices[base + 2] = pT.Z();
      p.delete();
      pT.delete();
    }

    const indices: number[] = new Array((nbNodes - 1) * 2);
    for (let i = 0; i < nbNodes - 1; i++) {
      indices[i * 2] = i;
      indices[i * 2 + 1] = i + 1;
    }

    tx.delete();
    poly.delete();
    tri.delete();
    loc.delete();

    return { vertices, normals: [], indices };
  }

  /**
   * Reads the stored 3D polygon for a free edge (one not attached to a
   * meshed face). Caller must have already run `ensureTriangulated` on the
   * edge or its parent wire.
   */
  static discretizeEdgeRaw(edge: TopoDS_Shape, opts?: EnsureTriangulatedOptions): MeshData {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);

    if (oc.BRep_Tool.Degenerated(ocEdge)) {
      ocEdge.delete();
      return { vertices: [], normals: [], indices: [] };
    }

    Mesh.ensureTriangulated(edge, opts);

    const loc = new oc.TopLoc_Location();
    const poly = oc.BRep_Tool.Polygon3D(ocEdge, loc);
    if (poly.isNull()) {
      poly.delete();
      loc.delete();
      ocEdge.delete();
      console.warn("Edge has no stored Polygon3D after meshing; returning empty polyline.");
      return { vertices: [], normals: [], indices: [] };
    }

    const nbNodes = poly.NbNodes();
    const nodes = poly.Nodes();
    const tx = loc.Transformation();

    const vertices: number[] = new Array(nbNodes * 3);
    for (let i = 1; i <= nbNodes; i++) {
      const p = nodes.Value(i);
      const pT = p.Transformed(tx);
      const base = (i - 1) * 3;
      vertices[base] = pT.X();
      vertices[base + 1] = pT.Y();
      vertices[base + 2] = pT.Z();
      p.delete();
      pT.delete();
    }

    const indices: number[] = new Array((nbNodes - 1) * 2);
    for (let i = 0; i < nbNodes - 1; i++) {
      indices[i * 2] = i;
      indices[i * 2 + 1] = i + 1;
    }

    tx.delete();
    poly.delete();
    loc.delete();
    ocEdge.delete();

    return { vertices, normals: [], indices };
  }
}
