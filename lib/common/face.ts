import type { TopoDS_Edge, TopoDS_Face } from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import { HiddenEdges } from "../oc/hidden-edges.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BoundingBox } from "../helpers/types.js";
import { ShapeType } from "./shape-type.js";
import { Wire } from "./wire.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Shape } from "./shape.js";
import { Edge } from "./edge.js";
import { Vector3d } from "../math/vector3d.js";

/**
 * Which loop of a face an edge lies on: its outer boundary, or the rim of
 * one of its holes. Loop membership is relative to a face — a bore's rim is
 * a hole of the plate's top face and the outer wire of the bore's wall.
 */
export type WireRole = 'outer' | 'hole';

export class Face extends Shape<TopoDS_Face> {
  protected normal: Vector3d = null;
  protected boundingBox: BoundingBox = null;

  private edges: Edge[] = null;
  private wires: Wire[] = null;
  private outerWire: Wire | null | undefined = undefined;

  constructor(face: TopoDS_Face) {
    super(face);
  }

  getType(): ShapeType {
    return "face";
  }

  override isFace(): boolean {
    return true;
  }

  getSubShapes(type: ShapeType): Shape[] {
    if (type === 'face') {
      return [this];
    }
    else if (type === 'edge') {
      return this.getEdges();
    }

    return [];
  }

  /**
   * The face's model edges. Its seam (an edge the wires traverse twice) and
   * degenerated edges are left out — see `HiddenEdges`.
   */
  getEdges(): Edge[] {
    if (this.edges) {
      return this.edges;
    }

    const wires = this.getWires();
    const all = wires.flatMap(w => w.getEdges());
    const hidden = HiddenEdges.ofFace(this.getShape());
    if (hidden.length === 0) {
      this.edges = all;
      return this.edges;
    }
    const hiddenSet = TopologyIndex.buildShapeSet(hidden);
    try {
      this.edges = all.filter(e => !hiddenSet.Contains(e.getShape()));
    } finally {
      hiddenSet.delete();
    }
    return this.edges;
  }

  getWires(): Wire[] {
    if (this.wires) {
      return this.wires;
    }

    this.wires = Explorer.findWiresWrapped(this);
    return this.wires;
  }

  /**
   * The face's outer boundary wire — the same wrapper `getWires()` holds, so
   * identity is shared. Null only for a face the kernel cannot bound.
   */
  getOuterWire(): Wire | null {
    if (this.outerWire !== undefined) {
      return this.outerWire;
    }

    const raw = FaceOps.outerWireRaw(this.getShape());
    try {
      this.outerWire = this.getWires().find(w => w.getShape().IsSame(raw)) ?? null;
    } finally {
      raw.delete();
    }
    return this.outerWire;
  }

  /** Every wire of the face but the outer one — one per hole. */
  getHoleWires(): Wire[] {
    const outer = this.getOuterWire();
    return this.getWires().filter(w => w !== outer);
  }

  /**
   * The loop of this face the edge lies on, or null when the edge does not
   * bound the face. Matches by `IsPartner`, so an orientation copy of the
   * edge (the one the neighbouring face holds) resolves too.
   */
  wireRoleOf(edge: TopoDS_Edge): WireRole | null {
    const onWire = (wire: Wire) => wire.getEdges().some(e => e.getShape().IsPartner(edge));
    const outer = this.getOuterWire();
    if (outer && onWire(outer)) {
      return 'outer';
    }
    if (this.getHoleWires().some(onWire)) {
      return 'hole';
    }
    return null;
  }

  override getLinkedShapes(): Shape[] {
    const linked = super.getLinkedShapes();
    if (this.edges) {
      linked.push(...this.edges);
    }
    if (this.wires) {
      linked.push(...this.wires);
    }
    return linked;
  }

  override release(retainedRaw: ReadonlySet<object>, deletedRaw: Set<object>): void {
    if (this.isReleased()) {
      return;
    }
    this.edges = null;
    this.wires = null;
    this.outerWire = undefined;
    super.release(retainedRaw, deletedRaw);
  }

  hasEdge(edge: TopoDS_Edge): Edge {
    const edges = this.getEdges();
    return edges.find(e => e.getShape().IsPartner(edge)) || null;
  }

  getNormal(): Vector3d {
    return this.normal;
  }

  getBoundingBox(): BoundingBox {
    if (this.boundingBox) {
      return this.boundingBox;
    }

    this.boundingBox = ShapeOps.getBoundingBox(this.getShape());
    return this.boundingBox;
  }

  center() {
    const bbox = this.getBoundingBox();
    return new Point(
      (bbox.minX + bbox.maxX) / 2,
      (bbox.minY + bbox.maxY) / 2,
      (bbox.minZ + bbox.maxZ) / 2
    );
  }

  static fromTopoDSFace(face: TopoDS_Face): Face {
    return new Face(face);
  }

  getPlane(): Plane {
    return FaceOps.getPlane(this.getShape());
  }

  getFaces(): TopoDS_Face[] {
    return [this.getShape()];
  }

  calculateNormal() {
    return FaceOps.calculateNormal(this.getShape());
  }

  compareTo(other: Face): boolean {
    if (!(other instanceof Face)) {
      return false;
    }

    return this.getShape().IsPartner(other.getShape());
  }

  serialize() {
    return {}
  }
}
