import { SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { LazyVertex } from "./lazy-vertex.js";

export class Trim2D extends GeometrySceneObject {
  private _points: LazyVertex[] = [];
  private _picking = false;
  private _pickPoints: LazyVertex[] = [];

  constructor() {
    super();
  }

  points(...ps: LazyVertex[]): this {
    this._points = ps;
    return this;
  }

  pick(...ps: LazyVertex[]): this {
    this._picking = true;
    this._pickPoints = ps;
    return this;
  }

  isPicking(): boolean {
    return this._picking;
  }

  getPickPoints(): LazyVertex[] {
    return this._pickPoints;
  }

  get trimPoints(): LazyVertex[] {
    return this._points;
  }

  build() {
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

    if (allEdges.length === 0) {
      return;
    }

    const activePoints = this._picking ? this._pickPoints : this._points;

    const TRIM_TOLERANCE = 50;

    // Split all edges at intersection points
    const splitResult = EdgeOps.splitEdgesWithMapping(allEdges);
    const splitEdges = splitResult.edges;
    const sourceIndex = splitResult.sourceIndex;

    // Find split edges to remove
    const splitEdgesToRemove = new Set<number>();
    if (activePoints.length > 0) {
      for (const lazyPoint of activePoints) {
        const point2d = lazyPoint.asPoint2D();
        const point3d = plane.localToWorld(point2d);
        for (const idx of EdgeOps.findNearestEdgeIndices(splitEdges, point3d, TRIM_TOLERANCE)) {
          splitEdgesToRemove.add(idx);
        }
      }

      // Remove affected original wires and re-add surviving split edges
      const removedWires = new Set<Wire | Edge>();
      for (const idx of splitEdgesToRemove) {
        const origEdge = allEdges[sourceIndex[idx]];
        const entry = edgeToOwner.get(origEdge)!;
        if (!removedWires.has(entry.wire)) {
          removedWires.add(entry.wire);
          entry.owner.removeShape(entry.wire, this);
        }
      }

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

    // --- Meta shapes for segment-level hover ---
    // Originals with trims need the first-pass split (to preserve trim boundaries).
    // Originals without trims are re-split against only surviving edges
    // (so ghost intersections from fully-removed edges disappear).

    const origSurvives = new Set<number>();
    const origHasTrim = new Array(allEdges.length).fill(false);
    for (let i = 0; i < splitEdges.length; i++) {
      if (!splitEdgesToRemove.has(i)) {
        origSurvives.add(sourceIndex[i]);
      } else {
        origHasTrim[sourceIndex[i]] = true;
      }
    }

    // Re-split only surviving originals (for clean meta shapes of untrimmed edges)
    const metaInputEdges: Edge[] = [];
    const metaInputToOrig: number[] = [];
    for (let i = 0; i < allEdges.length; i++) {
      if (origSurvives.has(i)) {
        metaInputEdges.push(allEdges[i]);
        metaInputToOrig.push(i);
      }
    }
    const metaSplit = EdgeOps.splitEdgesWithMapping(metaInputEdges);

    // Untrimmed originals: use re-split result (clean, no ghost intersections)
    for (let i = 0; i < metaSplit.edges.length; i++) {
      const origIdx = metaInputToOrig[metaSplit.sourceIndex[i]];
      if (origHasTrim[origIdx]) {
        continue;
      }
      const metaEdge = Edge.fromTopoDSEdge(metaSplit.edges[i].getShape());
      metaEdge.markAsMetaShape('trim');
      this.addShape(metaEdge);
    }

    // Trimmed originals: use first-pass surviving split edges (preserve boundaries)
    for (let i = 0; i < splitEdges.length; i++) {
      if (splitEdgesToRemove.has(i)) {
        continue;
      }
      if (!origHasTrim[sourceIndex[i]]) {
        continue;
      }
      const metaEdge = Edge.fromTopoDSEdge(splitEdges[i].getShape());
      metaEdge.markAsMetaShape('trim');
      this.addShape(metaEdge);
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
    if (this._picking) {
      copy.pick(...this._pickPoints);
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

    if (this._picking !== other._picking) {
      return false;
    }

    if (this._pickPoints.length !== other._pickPoints.length) {
      return false;
    }

    for (let i = 0; i < this._pickPoints.length; i++) {
      if (!this._pickPoints[i].compareTo(other._pickPoints[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "trim2d";
  }

  serialize() {
    return {
      trigger: this._points.length === 0 ? 'trim-picking' as const : undefined,
      picking: this._picking || undefined,
      pickPoints: this._picking
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    };
  }
}
