import type {
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Solid,
  TopTools_IndexedDataMapOfShapeListOfShape,
} from "occjs-wrapper";
import { Explorer } from "../oc/explorer.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";

export class Solid extends Shape<TopoDS_Solid> {
  private faces: Face[] = null;
  private edges: Edge[] = null;
  private edgeToFacesIndex: TopTools_IndexedDataMapOfShapeListOfShape | null = null;

  constructor(solid: TopoDS_Solid) {
    super(solid);
  }

  getType(): ShapeType {
    return "solid";
  }

  override isSolid() {
    return true;
  }

  getSubShapes(type: ShapeType): Shape[] {
    if (type === "face") {
      return this.getFaces();
    }
    else if (type === "edge") {
      return this.getEdges();
    }

    return [];
  }

  getEdges() {
    if (this.edges) {
      return this.edges;
    }

    this.edges = Explorer.findEdgesWrapped(this);
    return this.edges;
  }

  getFaces() {
    if (this.faces) {
      return this.faces;
    }

    this.faces = Explorer.findFacesWrapped(this);
    return this.faces;
  }

  getFace(face: TopoDS_Face): Face | null {
    const faces = this.getFaces();
    return faces.find(f => f.getShape().IsPartner(face)) || null;
  }

  hasFace(face: TopoDS_Face): boolean {
    const faces = this.getFaces();
    for (const f of faces) {
      const tpFace = f.getShape();
      if (tpFace.IsSame(face)) {
        return true;
      }
    }
    return false;
  }

  hasEdge(edge: TopoDS_Edge): TopoDS_Edge {
    const edges = this.getEdges();
    for (const e of edges) {
      const tpEdge = e.getShape();
      if (tpEdge.IsSame(edge)) {
        return tpEdge;
      }
    }

    return null;
  }

  getEdgeToFacesIndex(): TopTools_IndexedDataMapOfShapeListOfShape {
    if (!this.edgeToFacesIndex) {
      this.edgeToFacesIndex = TopologyIndex.buildEdgeToFaces(this.getShape());
    }
    return this.edgeToFacesIndex;
  }

  override dispose() {
    this.edgeToFacesIndex?.delete();
    this.edgeToFacesIndex = null;
    super.dispose();
  }

  override copy(): Shape {
    const copied = new Solid(this.getShape());
    for (const entry of this.colorMap) {
      copied.colorMap.push({ shape: entry.shape, color: entry.color });
    }
    return copied;
  }

  static fromTopoDSSolid(solid: TopoDS_Solid): Solid {
    return new Solid(solid);
  }
}
