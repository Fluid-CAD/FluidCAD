import { SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { LazyVertex } from "./lazy-vertex.js";

export class Trim2D extends GeometrySceneObject {
  private _points: LazyVertex[] = [];

  constructor() {
    super();
  }

  points(...ps: LazyVertex[]): this {
    this._points = ps;
    return this;
  }

  get trimPoints(): LazyVertex[] {
    return this._points;
  }

  build() {
    if (this._points.length === 0) {
      return;
    }

    const plane = this.sketch.getPlane();
    const sourceWires = this.sketch.getGeometriesWithOwner();

    // Collect all individual edges from wires/edges in the sketch
    const allEdges: Edge[] = [];
    const edgeToOwner = new Map<Edge, { wire: Wire | Edge; owner: SceneObject }>();

    for (const [wireOrEdge, owner] of sourceWires) {
      if (wireOrEdge instanceof Wire) {
        for (const edge of wireOrEdge.getEdges()) {
          allEdges.push(edge);
          edgeToOwner.set(edge, { wire: wireOrEdge, owner });
        }
      } else if (wireOrEdge instanceof Edge) {
        allEdges.push(wireOrEdge);
        edgeToOwner.set(wireOrEdge, { wire: wireOrEdge, owner });
      }
    }

    // Find edges nearest to each point (with tolerance)
    const TRIM_TOLERANCE = 50;
    const edgesToRemove = new Set<number>();
    for (const lazyPoint of this._points) {
      const point2d = lazyPoint.asPoint2D();
      const point3d = plane.localToWorld(point2d);
      const idx = EdgeOps.findNearestEdgeIndex(allEdges, point3d, TRIM_TOLERANCE);
      if (idx >= 0) {
        edgesToRemove.add(idx);
      }
    }

    // Remove original wires/edges that contain a trimmed edge
    const removedWires = new Set<Wire | Edge>();
    for (let i = 0; i < allEdges.length; i++) {
      if (edgesToRemove.has(i)) {
        const entry = edgeToOwner.get(allEdges[i])!;
        if (!removedWires.has(entry.wire)) {
          removedWires.add(entry.wire);
          entry.owner.removeShape(entry.wire, this);
        }
      }
    }

    // Re-add edges that were NOT trimmed (from wires that were removed)
    for (let i = 0; i < allEdges.length; i++) {
      if (!edgesToRemove.has(i)) {
        const entry = edgeToOwner.get(allEdges[i])!;
        if (removedWires.has(entry.wire)) {
          this.addShape(allEdges[i]);
        }
      }
    }
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Trim2D();
    if (this._points.length > 0) {
      copy.points(...this._points);
    }
    return copy;
  }

  compareTo(other: Trim2D): boolean {
    if (!(other instanceof Trim2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this._points.length !== other._points.length) {
      return false;
    }

    for (let i = 0; i < this._points.length; i++) {
      if (!this._points[i].compareTo(other._points[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "trim2d";
  }

  serialize() {
    return {};
  }
}
