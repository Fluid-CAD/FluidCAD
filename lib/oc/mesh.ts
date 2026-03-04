import type { TopoDS_Face, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";

export interface MeshData {
  vertices: number[];
  normals: number[];
  indices: number[];
  count?: number;
}

export class Mesh {
  // Wrapper methods (public API for external callers)
  static triangulateFace(face: Face, vertexOffset: number = 0): MeshData | null {
    return Mesh.triangulateFaceRaw(face.getShape() as TopoDS_Face, vertexOffset);
  }

  static discretizeEdge(edge: Shape): MeshData {
    return Mesh.discretizeEdgeRaw(edge.getShape());
  }

  // Raw methods (for oc-internal use)
  static triangulateFaceRaw(face: TopoDS_Face, vertexOffset: number = 0): MeshData | null {
    const oc = getOC();

    const vertices: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    let inc;
    try {
      inc = new oc.BRepMesh_IncrementalMesh(face, 0.01, false, 0.1, false);
    } catch (e) {
      console.error("Face mesh failed", e);
      return null;
    }

    const aLocation = new oc.TopLoc_Location();
    const myT = oc.BRep_Tool.Triangulation(face, aLocation, 0);
    if (myT.IsNull()) {
      aLocation.delete();
      inc.delete();
      throw new Error("No triangulation for face");
    }

    const pc = new oc.Poly_Connect(myT);
    const triangulation = myT.get();
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

    const myNormal = new oc.TColgp_Array1OfDir(1, nbNodes);
    oc.StdPrs_ToolTriangulatedShape.Normal(face, pc, myNormal);

    for (let i = 1; i <= nbNodes; i++) {
      const t1 = aLocation.Transformation();
      const d1 = myNormal.Value(i);
      const d = d1.Transformed(t1);
      normals.push(d.X(), d.Y(), d.Z());
      d1.delete();
      d.delete();
      t1.delete();
    }

    const orient = face.Orientation();
    const triangles = triangulation.Triangles();
    for (let nt = 1; nt <= triangulation.NbTriangles(); nt++) {
      const t = triangles.Value(nt);
      let n1 = t.Value(1) - 1;
      let n2 = t.Value(2) - 1;
      let n3 = t.Value(3) - 1;
      if (orient !== oc.TopAbs_Orientation.TopAbs_FORWARD) {
        [n1, n2] = [n2, n1];
      }
      indices.push(vertexOffset + n1, vertexOffset + n2, vertexOffset + n3);
      t.delete();
    }

    pc.delete();
    myNormal.delete();
    triangles.delete();
    myT.delete();
    aLocation.delete();
    inc.delete();

    return { vertices, normals, indices, count: nbNodes };
  }

  static discretizeEdgeRaw(edge: TopoDS_Shape): MeshData {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);
    const type = adaptor.GetType();

    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();

    const points: number[] = [];

    if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const startPnt = adaptor.Value(first);
      const endPnt = adaptor.Value(last);
      points.push(startPnt.X(), startPnt.Y(), startPnt.Z());
      points.push(endPnt.X(), endPnt.Y(), endPnt.Z());
      startPnt.delete();
      endPnt.delete();
    } else {
      const numSegments = Math.max(1, Math.floor((last - first) / 0.01));

      for (let i = 0; i <= numSegments; i++) {
        const t = first + ((last - first) * i) / numSegments;
        const pnt = adaptor.Value(t);
        points.push(pnt.X(), pnt.Y(), pnt.Z());
        pnt.delete();
      }
    }

    adaptor.delete();
    ocEdge.delete();

    const pointCount = points.length / 3;
    const indices: number[] = [];

    for (let i = 0; i < pointCount - 1; i++) {
      indices[2 * i] = i;
      indices[2 * i + 1] = i + 1;
    }

    return { vertices: points, normals: [], indices };
  }
}
