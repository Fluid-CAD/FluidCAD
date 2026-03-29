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

    // Split all edges at intersection points
    const splitResult = EdgeOps.splitEdgesWithMapping(allEdges);
    const splitEdges = splitResult.edges;
    const sourceIndex = splitResult.sourceIndex;

    // Find split edges nearest to each trim point
    const TRIM_TOLERANCE = 50;
    const splitEdgesToRemove = new Set<number>();
    for (const lazyPoint of this._points) {
      const point2d = lazyPoint.asPoint2D();
      const point3d = plane.localToWorld(point2d);
      const indices = EdgeOps.findNearestEdgeIndices(splitEdges, point3d, TRIM_TOLERANCE);
      for (const idx of indices) {
        splitEdgesToRemove.add(idx);
      }
    }

    // Remove affected original wires from their owners
    const removedWires = new Set<Wire | Edge>();
    for (const idx of splitEdgesToRemove) {
      const origEdge = allEdges[sourceIndex[idx]];
      const entry = edgeToOwner.get(origEdge)!;
      if (!removedWires.has(entry.wire)) {
        removedWires.add(entry.wire);
        entry.owner.removeShape(entry.wire, this);
      }
    }

    // Re-add surviving split edges from affected wires
    for (let i = 0; i < splitEdges.length; i++) {
      if (splitEdgesToRemove.has(i)) {
        continue;
      }
      const origEdge = allEdges[sourceIndex[i]];
      const entry = edgeToOwner.get(origEdge)!;
      if (removedWires.has(entry.wire)) {
        this.addShape(splitEdges[i]);
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
