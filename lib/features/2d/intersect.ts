import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { SectionOps } from "../../oc/section-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { SelectSceneObject } from "../select.js";
import { LazyVertex } from "../lazy-vertex.js";
import {
  ReferenceEntityRecord, ReferenceEntityRef, ReferencePointRef, registerReferenceEntities,
} from "./solved/reference.js";
import { withUnit } from "../../units/registry.js";

export class Intersect extends ExtrudableGeometryBase {

  // Prepared (pre-solve) compute — see Projection for the pattern: the OCCT
  // section runs once, from the sketch's reference pre-pass or lazily from
  // build(); errors cache so the build slot re-throws after clearError().
  private _prepared: { edges: Edge[] } | null = null;
  private _prepareError: string | null = null;
  private _referenceRecords: ReferenceEntityRecord[] = [];

  constructor(private sourceObjects: SceneObject[], targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  /** Idempotent OCCT compute + fixed-entity registration (P6). */
  prepareReferences(): void {
    if (this._prepared || this._prepareError) {
      return;
    }
    try {
      const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
      // The pre-pass runs before the render loop reaches lazy accessor
      // sources (`e.endFaces()` lives inside the sketch body) — resolve them
      // early; their build latch makes the loop's own slot a no-op.
      for (const obj of this.sourceObjects) {
        if (obj instanceof LazySelectionSceneObject) {
          withUnit(obj.getUnit(), () => obj.build());
        }
      }
      const shapes = this.sourceObjects.flatMap(obj => obj.getShapes());

      const allEdges: Edge[] = [];
      for (const shape of shapes) {
        allEdges.push(...SectionOps.sectionShapeWithPlane(plane, shape));
      }

      // Dedup crossings shared between sources (parity with project) — it
      // also stabilizes the `.ref(i)` edge indices.
      // Section curves over B-spline surfaces come back as approximated
      // B-splines even when straight/circular — recognize them back to
      // analytic curves so they register as fixed reference entities.
      const uniqueEdges = EdgeOps.unifyCoincident(allEdges)
        .map(edge => EdgeOps.toAnalyticEdge(edge));
      for (const edge of uniqueEdges) {
        edge.setProvenance('intersected');
      }
      this._prepared = { edges: uniqueEdges };

      const solver = this.sketch?.isSolvedMode() ? this.sketch.solver() : null;
      if (solver) {
        this._referenceRecords = registerReferenceEntities(this, solver, plane, uniqueEdges);
      }
    } catch (error) {
      this._prepareError = error instanceof Error ? error.message : String(error);
    }
  }

  referenceEntities(): ReferenceEntityRecord[] {
    return this._referenceRecords;
  }

  referenceEdgeCount(): number {
    return this._prepared?.edges.length ?? 0;
  }

  /** Constraint target naming sectioned edge `i` (fixed reference, P6). */
  ref(index: number): ReferenceEntityRef {
    return new ReferenceEntityRef(this, index);
  }

  /** Single-entity sugar: the sectioned circle's center as a point target. */
  center(): ReferencePointRef {
    return new ReferencePointRef(this, null, 'center');
  }

  /** In a solved sketch, the single sectioned entity's start point; the
   * legacy chain-endpoint accessor otherwise. */
  override start(): LazyVertex {
    if (this.sketch?.isSolvedMode()) {
      return new ReferencePointRef(this, null, 'start');
    }
    return super.start();
  }

  override end(): LazyVertex {
    if (this.sketch?.isSolvedMode()) {
      return new ReferencePointRef(this, null, 'end');
    }
    return super.end();
  }

  build(_context?: BuildSceneObjectContext) {
    this.prepareReferences();
    if (this._prepareError) {
      throw new BuildError(this._prepareError);
    }
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const allEdges = this._prepared!.edges;
    this.addShapes(allEdges);

    // Section across multiple source faces yields an unordered edge set that
    // may form one connected chain, several disjoint chains, or closed loops.
    // Take the first connected group and use its actual chain endpoints —
    // not an arbitrary edge's vertices, which can land on interior junctions.
    if (allEdges.length > 0 && !this.sketch?.isSolvedMode()) {
      // Pen state stays a legacy concept — never written in a solved sketch.
      const groups = WireOps.groupConnectedEdges(allEdges);
      const endpoints = WireOps.findChainEndpoints(groups[0]);
      if (endpoints) {
        const localStart = plane.worldToLocal(endpoints.start.toPoint());
        const localEnd = plane.worldToLocal(endpoints.end.toPoint());

        this.setState('start', Vertex.fromPoint2D(localStart));
        this.setState('end', Vertex.fromPoint2D(localEnd));
      }
    }

    for (const obj of this.sourceObjects) {
      if (obj instanceof SelectSceneObject) {
        obj.removeShapes(this);
      }
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [...this.sourceObjects];
    if (this.targetPlane) {
      deps.push(this.targetPlane);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const objects = this.sourceObjects.map(obj => remap.get(obj) || obj);
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const copy = new Intersect(objects, targetPlane);
    // Clones of a solved sketch never re-solve — carry the prepared compute
    // and the registered fixed-entity records (P2 clone rule).
    copy._prepared = this._prepared;
    copy._prepareError = this._prepareError;
    copy._referenceRecords = this._referenceRecords;
    return copy;
  }

  compareTo(other: Intersect): boolean {
    if (!(other instanceof Intersect)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    const thisObjects = this.sourceObjects || [];
    const otherObjects = other.sourceObjects || [];

    if (thisObjects.length !== otherObjects.length) {
      return false;
    }

    for (let i = 0; i < thisObjects.length; i++) {
      if (!thisObjects[i].compareTo(otherObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'intersect';
  }

  serialize() {
    const base: Record<string, unknown> = {
      objectIds: this.sourceObjects.map(o => o.id),
    };
    if (this.sketch?.isSolvedMode()) {
      base.entities = this._referenceRecords.map(r => ({
        entityId: r.entityId, kind: r.kind, edgeIndex: r.edgeIndex,
      }));
      base.edgeCount = this.referenceEdgeCount();
    }
    return base;
  }
}
