import type {
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Solid,
  TopTools_IndexedDataMapOfShapeListOfShape,
  TopTools_MapOfShape,
} from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import { HiddenEdges } from "../oc/hidden-edges.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";

export class Solid extends Shape<TopoDS_Solid> {
  private faces: Face[] = null;
  private edges: Edge[] = null;
  /** Every edge in explorer order, hidden ones included — the index space of picks, measure and highlight. */
  private allEdges: Edge[] = null;
  private edgeToFacesIndex: TopTools_IndexedDataMapOfShapeListOfShape | null = null;
  private hiddenEdgeSet: TopTools_MapOfShape | null = null;

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

  /**
   * The solid's model edges: every edge except the hidden ones (seams and
   * degenerated edges, see `HiddenEdges`). This list does not preserve the
   * explorer numbering — index-based lookups go through
   * {@link getIndexedShapes}.
   */
  getEdges() {
    if (this.edges) {
      return this.edges;
    }

    const hidden = this.getHiddenEdgeSet();
    this.edges = (this.getIndexedShapes('edge') as Edge[]).filter(e => !hidden.Contains(e.getShape()));
    return this.edges;
  }

  /**
   * The face or edge list whose POSITION is the index picks, `measure`,
   * `hit_test` and highlights carry: explorer order, hidden edges included,
   * so a seam still occupies its slot and no index shifts when it is left
   * out of {@link getEdges}.
   */
  getIndexedShapes(kind: 'face' | 'edge'): Shape[] {
    if (kind === 'face') {
      return this.getFaces();
    }
    if (!this.allEdges) {
      this.allEdges = Explorer.findEdgesWrapped(this);
    }
    return this.allEdges;
  }

  /** Whether `edge` is a seam or degenerated edge of this solid — never drawn, never selectable. */
  isHiddenEdge(edge: TopoDS_Shape): boolean {
    return this.getHiddenEdgeSet().Contains(edge);
  }

  private getHiddenEdgeSet(): TopTools_MapOfShape {
    if (!this.hiddenEdgeSet) {
      this.hiddenEdgeSet = HiddenEdges.collect(this.getShape());
    }
    return this.hiddenEdgeSet;
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
    this.hiddenEdgeSet?.delete();
    this.hiddenEdgeSet = null;
    super.dispose();
  }

  override getLinkedShapes(): Shape[] {
    const linked = super.getLinkedShapes();
    if (this.faces) {
      linked.push(...this.faces);
    }
    if (this.allEdges) {
      linked.push(...this.allEdges);
    }
    return linked;
  }

  override release(retainedRaw: ReadonlySet<object>, deletedRaw: Set<object>): void {
    if (this.isReleased()) {
      return;
    }
    this.edgeToFacesIndex?.delete();
    this.edgeToFacesIndex = null;
    this.hiddenEdgeSet?.delete();
    this.hiddenEdgeSet = null;
    this.faces = null;
    this.edges = null;
    this.allEdges = null;
    super.release(retainedRaw, deletedRaw);
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
