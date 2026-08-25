import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { ProjectionOps } from "../../oc/intersection.js";
import { Wire } from "../../common/wire.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { LazyVertex } from "../lazy-vertex.js";
import {
  ReferenceEntityRecord, ReferenceEntityRef, ReferencePointRef, registerReferenceEntities,
} from "./solved/reference.js";

export class Projection extends ExtrudableGeometryBase {

  // Prepared (pre-solve) compute: the OCCT projection runs ONCE — either in
  // the sketch's reference pre-pass (solved sketches, before the solve) or
  // lazily from build(). Errors cache too: the render loop clearError()s the
  // object before its own build slot, so build() re-throws from here.
  private _prepared: { edges: Edge[]; endpoints: { start: Vertex, end: Vertex } | null } | null = null;
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
          obj.build();
        }
      }
      const shapes = this.sourceObjects.flatMap(obj => obj.getShapes());

      // Project every source first; collect all resulting wires before any
      // dedup. We need the full set up-front so the General Fuse in
      // unifyCoincident can detect overlaps across sources, not just within
      // one.
      const allWires: Wire[] = [];
      for (const shape of shapes) {
        let wires: Wire[] = [];
        if (shape instanceof Face) {
          wires = ProjectionOps.projectFaceOntoPlane(plane, shape as Face);
        } else if (shape instanceof Wire) {
          const firstEdge = shape.getEdges()[0];
          wires = ProjectionOps.projectEdgeOntoPlane(plane, firstEdge);
        } else if (shape instanceof Edge) {
          wires = ProjectionOps.projectEdgeOntoPlane(plane, shape);
        }
        allWires.push(...wires);
      }

      // Capture the sketch-cursor endpoints BEFORE dedup. unifyCoincident
      // may split/drop edges and the wire structure is discarded anyway, but
      // the chain endpoints of the first connected group are still the right
      // anchor for the sketch's current position. When multiple disjoint
      // pieces are projected, the first is a stable convention.
      const allEdges: Edge[] = allWires.flatMap(w => w.getEdges());
      let endpoints: { start: Vertex, end: Vertex } | null = null;
      if (allEdges.length > 0) {
        const groups = WireOps.groupConnectedEdges(allEdges);
        endpoints = WireOps.findChainEndpoints(groups[0]);
      }

      const uniqueEdges = EdgeOps.unifyCoincident(allEdges);
      for (const edge of uniqueEdges) {
        edge.setProvenance('projected');
      }
      this._prepared = { edges: uniqueEdges, endpoints };

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

  /** Constraint target naming projected edge `i` (fixed reference, P6). */
  ref(index: number): ReferenceEntityRef {
    return new ReferenceEntityRef(this, index);
  }

  /** Single-entity sugar: the projected bore's center as a point target. */
  center(): ReferencePointRef {
    return new ReferencePointRef(this, null, 'center');
  }

  /** In a solved sketch, the single projected entity's start point; the
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
    const uniqueEdges = this._prepared!.edges;
    this.addShapes(uniqueEdges);

    // Pen state stays a legacy concept — never written in a solved sketch.
    const endpoints = this._prepared!.endpoints;
    if (endpoints && !this.sketch?.isSolvedMode()) {
      const localStart = plane.worldToLocal(endpoints.start.toPoint());
      const localEnd = plane.worldToLocal(endpoints.end.toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));
    }

    for (const obj of this.sourceObjects) {
        obj.removeShapes(this);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }

    if (this.sketch && !this.sketch.isSolvedMode()) {
      this.setCurrentPosition(this.getCurrentPosition());
    }
  }

  /** The projected source selections, for edit-dialog seeding. */
  get sources(): SceneObject[] {
    return this.sourceObjects;
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
    const copy = new Projection(objects, targetPlane);
    // Clones of a solved sketch never re-solve — carry the prepared compute
    // and the registered fixed-entity records (P2 clone rule).
    copy._prepared = this._prepared;
    copy._prepareError = this._prepareError;
    copy._referenceRecords = this._referenceRecords;
    return copy;
  }

  compareTo(other: Projection): boolean {
    if (!(other instanceof Projection)) {
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
      const thisObj = thisObjects[i];
      const otherObj = otherObjects[i];

      if (!thisObj.compareTo(otherObj)) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'projection';
  }

  serialize() {
    const base: Record<string, unknown> = {
      objectIds: this.sourceObjects.map(o => o.id),
    };
    if (this.sketch?.isSolvedMode()) {
      // Fixed reference entities (P6): the UI joins these on entityId with
      // the sketch snapshot (which carries the locked params) for pick-only
      // constraint targeting; edgeIndex is the `.ref(i)` address emission
      // renders.
      base.entities = this._referenceRecords.map(r => ({
        entityId: r.entityId, kind: r.kind, edgeIndex: r.edgeIndex,
      }));
      base.edgeCount = this.referenceEdgeCount();
    }
    return base;
  }
}
