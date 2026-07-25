import { SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { EdgeTargetArg, GeometrySceneObject } from "./2d/geometry.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Plane } from "../math/plane.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";

/** A segment lies on a region boundary when its samples are this close. */
const SEGMENT_MATCH_TOLERANCE = 1e-6;

export class Trim2D extends GeometrySceneObject {
  private _targets: EdgeTargetArg[] = [];
  private _picking = false;
  private _pickPoints: LazyVertex[] = [];
  private _segments: Edge[] = [];

  constructor() {
    super();
  }

  /**
   * Removal targets: geometries, edge accessors (`r.edge('top')`) or edge
   * filters (`edge().line()`) — the shared 2D op target forms. Geometry and
   * accessor targets remove whole edges; filter targets are matched against
   * the sketch's split segments (geometry split at mutual intersections) and
   * remove the matching segments, mirroring the interactive trim.
   */
  setTargets(...targets: EdgeTargetArg[]): this {
    this._targets = targets;
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

  get targets(): EdgeTargetArg[] {
    return this._targets;
  }

  /**
   * The surviving split segments of the last build (the `trim` meta shapes),
   * available while picking is active. The trim-region selector synthesis
   * resolves region picks against this set.
   */
  getSegments(): Edge[] {
    return this._segments;
  }

  build() {
    this._segments = [];
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

    const sceneTargets = this._targets.filter(t => !(t instanceof FilterBuilderBase));
    const filterTargets = this._targets.filter(
      (t): t is FilterBuilderBase<Edge> => t instanceof FilterBuilderBase,
    );

    let removedWhole: Set<Edge> = new Set();
    if (sceneTargets.length > 0) {
      removedWhole = this.buildWithTargets(sceneTargets);
    }

    if (filterTargets.length === 0 && !this._picking) {
      return;
    }

    const pickableEdges = allEdges.filter(e => !removedWhole.has(e));
    this.buildSegments(pickableEdges, edgeToOwner, plane, filterTargets);
  }

  /**
   * Whole-edge removal through the shared resolver: targets resolve to their
   * edges mapped to the REAL owning feature (accessors and select statements
   * are reached through), and removal goes through the sketch so every holder
   * of the instance records it. Returns the removed set so the segment pass
   * excludes it.
   */
  private buildWithTargets(targets: EdgeTargetArg[]): Set<Edge> {
    const resolved = this.resolveEdgeTargets(targets);
    for (const edge of resolved.keys()) {
      this.sketch.removeShape(edge, this);
    }
    return new Set(resolved.keys());
  }

  /**
   * Segment-level removal: the pickable edges split at their mutual
   * intersections, with segments removed by filter targets and pick points.
   * While picking is active, the surviving segments (and the regions they
   * bound) are emitted as meta shapes for the interactive mode.
   */
  private buildSegments(
    pickableEdges: Edge[],
    edgeToOwner: Map<Edge, { wire: Wire | Edge; owner: SceneObject }>,
    plane: Plane,
    filterTargets: FilterBuilderBase<Edge>[],
  ) {

    const TRIM_TOLERANCE = 50;

    const splitResult = EdgeOps.splitEdgesWithMapping(pickableEdges);
    const splitEdges = splitResult.edges;
    const sourceIndex = splitResult.sourceIndex;

    const splitEdgesToRemove = new Set<number>();

    for (const filter of filterTargets) {
      const matches = new Set(new ShapeFilter(splitEdges, filter).apply() as Edge[]);
      for (let i = 0; i < splitEdges.length; i++) {
        if (matches.has(splitEdges[i])) {
          splitEdgesToRemove.add(i);
        }
      }
    }

    for (const lazyPoint of this._pickPoints) {
      const point2d = lazyPoint.asPoint2D();
      const point3d = plane.localToWorld(point2d);
      for (const idx of EdgeOps.findNearestEdgeIndices(splitEdges, point3d, TRIM_TOLERANCE)) {
        splitEdgesToRemove.add(idx);
      }
    }

    if (splitEdgesToRemove.size > 0) {
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
          splitEdges[i].copyRoleFrom(origEdge);
          splitEdges[i].setProvenance('trim-segment');
          this.addShape(splitEdges[i]);
        }
      }
    }

    if (!this._picking) {
      return;
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

    const metaEdges: Edge[] = [];
    for (let i = 0; i < metaSplit.edges.length; i++) {
      const origIdx = metaInputToOrig[metaSplit.sourceIndex[i]];
      if (origHasTrim[origIdx]) {
        continue;
      }
      const metaEdge = Edge.fromTopoDSEdge(metaSplit.edges[i].getShape());
      metaEdge.markAsMetaShape('trim');
      this.addShape(metaEdge);
      metaEdges.push(metaEdge);
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
      metaEdges.push(metaEdge);
    }

    this._segments = metaEdges;
    this.buildRegionMeta(metaEdges, plane);
  }

  /**
   * Region meta faces for by-region trimming: the surviving segments
   * partition the plane into cells; each cell is emitted as a `trim-region`
   * meta face whose metaData lists the ids of the segments bounding it, so
   * hovering a region can highlight (and clicking can trim) its boundary.
   */
  private buildRegionMeta(metaEdges: Edge[], plane: Plane): void {
    if (metaEdges.length === 0) {
      return;
    }

    let cells: Face[];
    try {
      cells = FaceMaker2.getRegions(metaEdges, plane, false);
    } catch {
      return;
    }

    for (const cell of cells) {
      // Attribute boundary by containment, not identity: the cell
      // decomposition splits closed curves at their period seam, so a
      // wrapped arc segment can span two boundary pieces.
      const boundary = cell.getEdges();
      const edgeIds: string[] = [];
      for (const segment of metaEdges) {
        if (EdgeOps.edgeLiesOnEdges(segment, boundary, SEGMENT_MATCH_TOLERANCE)) {
          edgeIds.push(segment.id);
        }
      }
      if (edgeIds.length === 0) {
        continue;
      }
      cell.markAsMetaShape('trim-region');
      cell.metaData = { edgeIds };
      this.addShape(cell);
    }
  }

  override getDependencies(): SceneObject[] {
    return GeometrySceneObject.sceneObjectTargets(this._targets);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Trim2D();
    if (this._targets.length > 0) {
      copy.setTargets(...GeometrySceneObject.remapEdgeTargets(this._targets, remap));
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

    if (!GeometrySceneObject.compareEdgeTargets(this._targets, other._targets)) {
      return false;
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
      hasTargets: this._targets.length > 0 || undefined,
    };
  }
}
