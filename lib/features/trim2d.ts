import { SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { LazyVertex } from "./lazy-vertex.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { Plane } from "../math/plane.js";

export class Trim2D extends GeometrySceneObject {
  private _filters: EdgeFilterBuilder[] = [];
  private _picking = false;
  private _pickPoints: LazyVertex[] = [];

  constructor() {
    super();
  }

  setFilters(...fs: EdgeFilterBuilder[]): this {
    this._filters = fs;
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

  get filters(): EdgeFilterBuilder[] {
    return this._filters;
  }

  build() {
    const plane = this.sketch.getPlane();
    const sourceWires = this.sketch.getGeometriesWithOwner();

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

    if (this._filters.length > 0) {
      this.buildWithFilters(allEdges, edgeToOwner);
    }

    if (this._picking) {
      let pickableEdges: Edge[];
      if (this._filters.length > 0) {
        const matched = new Set(new ShapeFilter(allEdges, ...this._filters).apply());
        pickableEdges = allEdges.filter(e => !matched.has(e));
      } else {
        pickableEdges = allEdges;
      }
      this.buildWithPicking(pickableEdges, edgeToOwner, plane);
    }
  }

  private buildWithFilters(allEdges: Edge[], edgeToOwner: Map<Edge, { wire: Wire | Edge; owner: SceneObject }>) {
    const matchedEdges = new ShapeFilter(allEdges, ...this._filters).apply() as Edge[];

    const removedWires = new Set<Wire | Edge>();
    for (const edge of matchedEdges) {
      const entry = edgeToOwner.get(edge)!;
      if (!removedWires.has(entry.wire)) {
        removedWires.add(entry.wire);
        entry.owner.removeShape(entry.wire, this);
      }
    }
  }

  private buildWithPicking(pickableEdges: Edge[], edgeToOwner: Map<Edge, { wire: Wire | Edge; owner: SceneObject }>, plane: Plane) {

    const TRIM_TOLERANCE = 50;

    const splitResult = EdgeOps.splitEdgesWithMapping(pickableEdges);
    const splitEdges = splitResult.edges;
    const sourceIndex = splitResult.sourceIndex;

    const splitEdgesToRemove = new Set<number>();
    if (this._pickPoints.length > 0) {
      for (const lazyPoint of this._pickPoints) {
        const point2d = lazyPoint.asPoint2D();
        const point3d = plane.localToWorld(point2d);
        for (const idx of EdgeOps.findNearestEdgeIndices(splitEdges, point3d, TRIM_TOLERANCE)) {
          splitEdgesToRemove.add(idx);
        }
      }

      const removedWires = new Set<Wire | Edge>();
      for (const idx of splitEdgesToRemove) {
        const origEdge = pickableEdges[sourceIndex[idx]];
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
        const origEdge = pickableEdges[sourceIndex[i]];
        const entry = edgeToOwner.get(origEdge)!;
        if (removedWires.has(entry.wire)) {
          this.addShape(splitEdges[i]);
        }
      }
    }

    // --- Meta shapes for segment-level hover ---
    const origSurvives = new Set<number>();
    const origHasTrim = new Array(pickableEdges.length).fill(false);
    for (let i = 0; i < splitEdges.length; i++) {
      if (!splitEdgesToRemove.has(i)) {
        origSurvives.add(sourceIndex[i]);
      } else {
        origHasTrim[sourceIndex[i]] = true;
      }
    }

    const metaInputEdges: Edge[] = [];
    const metaInputToOrig: number[] = [];
    for (let i = 0; i < pickableEdges.length; i++) {
      if (origSurvives.has(i)) {
        metaInputEdges.push(pickableEdges[i]);
        metaInputToOrig.push(i);
      }
    }
    const metaSplit = EdgeOps.splitEdgesWithMapping(metaInputEdges);

    for (let i = 0; i < metaSplit.edges.length; i++) {
      const origIdx = metaInputToOrig[metaSplit.sourceIndex[i]];
      if (origHasTrim[origIdx]) {
        continue;
      }
      const metaEdge = Edge.fromTopoDSEdge(metaSplit.edges[i].getShape());
      metaEdge.markAsMetaShape('trim');
      this.addShape(metaEdge);
    }

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
    if (this._filters.length > 0) {
      copy.setFilters(...this._filters);
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

    if (this._filters.length !== other._filters.length) {
      return false;
    }

    for (let i = 0; i < this._filters.length; i++) {
      if (!this._filters[i].equals(other._filters[i])) {
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
      trigger: 'trim-picking' as const,
      picking: this._picking || undefined,
      pickPoints: this._picking
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    };
  }
}
