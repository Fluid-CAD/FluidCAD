import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { SceneObject } from "../common/scene-object.js";
import { Point2D } from "../math/point.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { Copy2DInstance } from "./copy2d-instance-ref.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { SolvedGeometryBase } from "./2d/solved/solved-base.js";
import {
  collectSourceEntities,
  sourceEntitiesPayload,
  type TransformInputs,
} from "./2d/solved/source-entities.js";
import {
  entityPointFromParams,
  localAffineFromWorldMatrix,
  registerDuplicateEntity,
} from "./2d/solved/copy-entities.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { Plane } from "../math/plane.js";
import type { Sketch } from "./2d/sketch.js";
import type { EntityKind, PointRole, SolverRef } from "../sketch-solver/index.js";

/** One duplicate slot's world-space transform (the build stamps with it;
 * registration derives the equivalent sketch-local tie matrix from it). */
export type SlotTransform = { slot: number; matrix: Matrix4 };

/** The full grid layout of a copy: where the original sits, how many
 * slots exist, and the transform of every stamped (non-original,
 * non-skipped) slot. */
export type SlotLayout = {
  originalSlot: number;
  slotCount: number;
  duplicates: SlotTransform[];
};

/** Statement-time record of one registered duplicate entity. */
type DuplicateEntityRecord = {
  slot: number;
  source: SolvedGeometryBase;
  dupId: number;
  kind: EntityKind;
};

/** Everything instance() resolution needs, captured at registration. Null
 * when registration degraded (dynamic transform, unresolvable plane). */
type InstanceRegistration = {
  originalSlot: number;
  slotCount: number;
  duplicateSlots: number[];
  solverSources: SolvedGeometryBase[];
  /** Candidate sources that will stamp shapes but carry no solver
   * identity (offset results, nested copies, mirrors …). */
  nonSolverSources: number;
  duplicates: DuplicateEntityRecord[];
};

/**
 * Shared grid-slot bookkeeping for the 2D copies. A copy owns only the
 * duplicates it stamps — the source geometries keep their own shapes (the
 * copy never strips them), so a copied solved entity stays independently
 * pickable, draggable and constrainable. The grid-slot map still spans
 * EVERY slot, original included: `instance(i)` selects the whole block at
 * grid slot `i` — resolving the original's slot through its source
 * statement's live shapes — a closed region wherever the source was one.
 *
 * Slot numbering: linear copies linearize the grid in axis order (the first
 * axis varies slowest), the original occupying its own slot (0 when not
 * centered, the center slot when centered); circular copies count rotation
 * steps with the original at 0 — the same numbering their `skip` option uses.
 *
 * Solver identity (P8): when the copy's transform is statically known at
 * statement time, every solver-backed source registers one duplicate
 * entity per stamped slot, rigidly tied to it (addTransformTie) — so
 * `cp.instance(k)` is a first-class constraint target and constraining a
 * duplicate moves the source (and every sibling duplicate) with it.
 */
export abstract class Copy2DBase extends GeometrySceneObject {

  /** Explicit copy targets (both subclasses take them in construction);
   * null/empty = the target-less "copy everything before me" form. */
  abstract targetObjects: SceneObject[] | null;

  /** World-space transform of every duplicate slot plus the grid layout.
   * Called by build() (stamping) and — through
   * {@link statementSlotTransforms} — at registration time. */
  protected abstract slotTransforms(): SlotLayout;

  /**
   * The layout when the transform is STATICALLY constant at statement time,
   * or null to degrade (no duplicate entities, instance() not
   * constrainable): a solver-driven input (an axis from a solved line, a
   * `c.center()` rotation center) moves with the solve, but a tie matrix is
   * a constant — registering one would freeze the guess and let the tie
   * disagree with the build-time stamping.
   */
  protected abstract statementSlotTransforms(): SlotLayout | null;

  private _registration: InstanceRegistration | null = null;

  /**
   * The shape→slot map rides the STATE map, not an instance field: when
   * SceneCompare reuses an unchanged copy statement across renders, the new
   * object skips build() and serves the old object's transferred state — an
   * instance field would arrive empty and instance() would silently resolve
   * to nothing until a full recompute.
   */
  private get instanceByShape(): Map<Shape, number> | undefined {
    return this.getState('copy-instances');
  }

  /** (slot, source entity) → index into this copy's sceneShapes (addShape
   * order). State for the same cached-reuse reason as `copy-instances`;
   * keyed by entity id — stable across the identical re-runs SceneCompare
   * reuses — because the statements themselves are new objects per render. */
  private get shapeIndexByKey(): Map<string, number> | undefined {
    return this.getState('copy-entity-shapes');
  }

  private static instanceShapeKey(slot: number, sourceEntityId: number): string {
    return `${slot}:${sourceEntityId}`;
  }

  /** Build-derived state — every build() starts from empty maps. */
  protected resetInstances(): void {
    this.setState('copy-instances', new Map<Shape, number>());
    this.setState('copy-entity-shapes', new Map<string, number>());
  }

  /** Stamp `shape` as part of grid slot `index` (build-time only). */
  protected recordInstanceShape(shape: Shape, index: number): void {
    this.instanceByShape!.set(shape, index);
  }

  /**
   * Record the solver entities the duplicates derive from (build-time,
   * solved sketches only) — the viewport tints them with their sources'
   * constrained verdict. State for the same cached-reuse reason as
   * `copy-instances` above.
   */
  protected recordSourceEntities(objects: SceneObject[], inputs?: TransformInputs): void {
    if (this.sketch.isSolvedMode()) {
      this.setState('source-entities', collectSourceEntities(objects, inputs));
    }
  }

  protected sourceEntitiesPayload(): Record<string, unknown> {
    return sourceEntitiesPayload(this.getState('source-entities'));
  }

  // -- solver duplicate registration (statement time) -----------------------

  /**
   * Register one duplicate solver entity per (stamped slot × solver-backed
   * source) and tie each to its source. Called by the copy() command
   * factory right after addSceneObject — before any constraint statement
   * can name an instance — so entity ids exist when `cp.instance(k)`
   * resolves. Degrades silently (no duplicates, instance() resolution
   * errors honestly) when the transform is not statically known: the
   * existing non-solver behavior.
   */
  registerSolverDuplicates(sk: Sketch | null): void {
    if (!sk || !sk.isSolvedMode()) {
      return;
    }
    const ctx = sk.solver();
    if (!ctx) {
      return;
    }

    const layout = this.statementSlotTransforms();
    if (!layout) {
      return;
    }

    // The sketch plane may not resolve at statement time (a face-based
    // sketch whose support only exists at build time) — degrade.
    let plane: Plane | null = null;
    try {
      plane = sk.getPlane();
    } catch {
      return;
    }
    if (!plane) {
      return;
    }

    // Classify candidate sources by what they will stamp at build time.
    // Guides and lazies stamp nothing (the build's default getShapes()
    // filter drops them); constraint statements have no geometry at all.
    const solverSources: SolvedGeometryBase[] = [];
    let nonSolverSources = 0;
    for (const obj of this.candidateSources(sk)) {
      if (obj.isLazy() || obj.isSelection() || obj.isGuide()) {
        continue;
      }
      if (!(obj instanceof GeometrySceneObject)) {
        continue;
      }
      if (obj instanceof SolvedGeometryBase) {
        if (obj.entityId >= 0) {
          solverSources.push(obj);
        }
        continue;
      }
      nonSolverSources++;
    }

    const duplicates: DuplicateEntityRecord[] = [];
    for (const { slot, matrix } of layout.duplicates) {
      const affine = localAffineFromWorldMatrix(matrix, plane);
      for (const source of solverSources) {
        const dupId = registerDuplicateEntity(ctx, this, source, affine);
        ctx.addTransformTie(source.entityId, dupId, affine);
        duplicates.push({ slot, source, dupId, kind: source.solverKind });
      }
    }

    this._registration = {
      originalSlot: layout.originalSlot,
      slotCount: layout.slotCount,
      duplicateSlots: layout.duplicates.map(d => d.slot),
      solverSources,
      nonSolverSources,
      duplicates,
    };
  }

  /** Statement-time view of the build-time source walk: explicit targets
   * filtered to actual siblings, or every previous sibling. */
  private candidateSources(sk: Sketch): SceneObject[] {
    const siblings = sk.getPreviousSiblings(this);
    if (this.targetObjects && this.targetObjects.length > 0) {
      return siblings.filter(obj => this.targetObjects!.includes(obj));
    }
    return siblings;
  }

  // -- build-time stamping --------------------------------------------------

  /**
   * Stamp every duplicate slot: one transformed copy of each source shape
   * per slot, recorded into the slot map AND — for solver-backed sources —
   * into the (slot, source entity) → sceneShapes-index join serialize()
   * ships. Shared by both copy kinds; the per-kind build only resolves its
   * sources and layout.
   */
  protected stampDuplicates(objects: SceneObject[], duplicates: SlotTransform[]): void {
    const shapeIndexByKey = this.shapeIndexByKey!;
    let shapeIndex = 0;
    for (const { slot, matrix } of duplicates) {
      for (const obj of objects) {
        const shapes = obj.getShapes();
        // Solver-backed statements stamp exactly one shape; anything else
        // (or a multi-shape oddity) gets no entity join.
        const sourceEntityId = obj instanceof SolvedGeometryBase && obj.entityId >= 0 && shapes.length === 1
          ? obj.entityId
          : null;
        for (const shape of shapes) {
          const transformed = ShapeOps.transform(shape, matrix);
          transformed.setMeshSource(shape, matrix);
          this.addShape(transformed);
          this.recordInstanceShape(transformed, slot);
          if (sourceEntityId !== null) {
            shapeIndexByKey.set(Copy2DBase.instanceShapeKey(slot, sourceEntityId), shapeIndex);
          }
          shapeIndex++;
        }
      }
    }
  }

  // -- payload --------------------------------------------------------------

  /**
   * The `entities[]` payload fragment: one record per solver-backed
   * duplicate shape, joining the statement-time entity registration to the
   * build-time stamping through (slot, source entity) identity. A source
   * whose shape never stamped (consumed upstream) simply emits no record.
   */
  protected instanceEntitiesPayload(): Record<string, unknown> {
    const registration = this._registration;
    const shapeIndexByKey = this.shapeIndexByKey;
    if (!registration || registration.duplicates.length === 0 || !shapeIndexByKey) {
      return {};
    }
    const entities: { entityId: number; kind: EntityKind; slot: number; shapeIndex: number }[] = [];
    for (const d of registration.duplicates) {
      const shapeIndex = shapeIndexByKey.get(Copy2DBase.instanceShapeKey(d.slot, d.source.entityId));
      if (shapeIndex === undefined) {
        continue;
      }
      entities.push({ entityId: d.dupId, kind: d.kind, slot: d.slot, shapeIndex });
    }
    if (entities.length === 0) {
      return {};
    }
    return { entities };
  }

  // -- instance() constraint resolution -------------------------------------

  /**
   * The slot's single solver-backed entity: the registered duplicate for a
   * stamped slot, the SOURCE statement's own entity for the original's slot
   * (constraining `cp.instance(originalSlot)` IS constraining the source).
   * Throws statement-speak errors — the constraint emission path stashes
   * them on the constraint statement.
   */
  private resolveInstanceEntity(slot: number, what: string): { entityId: number; kind: EntityKind } {
    const registration = this._registration;
    if (!registration) {
      throw new Error(
        `${what}: this copy's instances have no solver identity — its transform is not statically known at statement time; constrain the source statement instead`,
      );
    }

    const validSlots = [registration.originalSlot, ...registration.duplicateSlots]
      .sort((a, b) => a - b)
      .join(', ');
    if (!Number.isInteger(slot) || slot < 0 || slot >= registration.slotCount) {
      throw new Error(`${what}: instance(${slot}) is out of range — valid slots: ${validSlots}`);
    }

    const isOriginal = slot === registration.originalSlot;
    if (!isOriginal && !registration.duplicateSlots.includes(slot)) {
      throw new Error(`${what}: instance(${slot}) was skipped by this copy — valid slots: ${validSlots}`);
    }

    const total = registration.solverSources.length + registration.nonSolverSources;
    if (total > 1) {
      throw new Error(
        `${what}: instance(${slot}) carries ${total} edges — per-edge targeting is not supported yet; constrain the source statement instead`,
      );
    }
    if (registration.solverSources.length === 0) {
      throw new Error(
        `${what}: instance(${slot})'s source geometry has no solver identity (an offset result or nested copy) — constrain a drawn line/arc/circle/point statement instead`,
      );
    }

    const source = registration.solverSources[0];
    if (isOriginal) {
      return { entityId: source.entityId, kind: source.solverKind };
    }
    const record = registration.duplicates.find(d => d.slot === slot && d.source === source)!;
    return { entityId: record.dupId, kind: record.kind };
  }

  /** Role validity per entity kind — point instances answer every accessor
   * with themselves, mirroring SolvedPoint.start()/end(). */
  private static validateInstanceRole(kind: EntityKind, role: PointRole, what: string): void {
    if (kind === 'line' && role === 'center') {
      throw new Error(`${what}: a line instance has no center() point`);
    }
    if (kind === 'circle' && role !== 'center') {
      throw new Error(`${what}: a circle instance only has a center() point`);
    }
  }

  /** Solver ref for `cp.instance(slot)` (optionally one of its points). */
  instanceSolverRef(slot: number, what: string, role?: PointRole): SolverRef {
    const { entityId, kind } = this.resolveInstanceEntity(slot, what);
    if (role === undefined || kind === 'point') {
      return { entity: entityId };
    }
    Copy2DBase.validateInstanceRole(kind, role, what);
    return { entity: entityId, point: role };
  }

  /** Current value of one of an instance's named points (guesses until the
   * solve has run) — the Copy2DInstancePointRef vertex read. */
  instancePointValue(slot: number, role: PointRole): Point2D {
    const what = `instance ${role}`;
    const { entityId, kind } = this.resolveInstanceEntity(slot, what);
    if (kind !== 'point') {
      Copy2DBase.validateInstanceRole(kind, role, what);
    }
    const ctx = this.sketch?.solver();
    if (!ctx) {
      throw new Error(`${what}: the copy is not inside a constraint sketch`);
    }
    return entityPointFromParams(kind, ctx.entityParams(entityId), role);
  }

  // -- selection accessors --------------------------------------------------

  /** The grid slot a shape was stamped into, or null for foreign shapes. */
  getInstanceIndex(shape: Shape): number | null {
    return this.instanceByShape?.get(shape) ?? null;
  }

  /**
   * The still-live real edges of grid slot `index`, in build order. Duplicate
   * slots resolve through the copy's own getShapes(); the original's slot
   * through its source statements' (scope-less reads, so edges hard-consumed
   * by downstream ops drop out of both).
   */
  getInstanceEdges(index: number): Edge[] {
    const instances = this.instanceByShape;
    if (!instances) {
      return [];
    }
    const live = new Set<Shape>(this.getShapes());
    for (const sibling of this.sketch.getPreviousSiblings(this)) {
      for (const shape of sibling.getShapes()) {
        live.add(shape);
      }
    }
    const edges: Edge[] = [];
    for (const [shape, slot] of instances) {
      if (slot === index && shape instanceof Edge && live.has(shape)) {
        edges.push(shape);
      }
    }
    return edges;
  }

  /**
   * One grid slot of the copy as a lazy selection — the whole copied geometry
   * at that position, for ops that take whole-geometry operands — and, when
   * the slot holds exactly one solver-backed edge, a constraint target.
   */
  instance(index: number): Copy2DInstance {
    return new Copy2DInstance(this.generateUniqueName(`instance-${index}`), this, index);
  }
}
