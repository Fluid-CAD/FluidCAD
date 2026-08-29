// Macro shapes (fluidcad/shapes): ONE statement that registers a family of
// ordinary solver sub-entities plus INTERNAL constraint rows for its shape
// rules — to the user an atomic, self-constrained unit (one timeline row,
// no badges, nothing individually deletable), to the solver plain entities
// and rows that interact soundly with external constraints through the one
// solve. Chained modifiers (`.radius()`, `.centered()`) change the entity
// count, so registration happens at the sketch's pre-solve pass
// (finalizeMacro), not at statement time; constraints naming the accessors
// register deferred with placeholder ids, like projected references.

import { GeometrySceneObject } from "../../geometry.js";
import { BuildError } from "../../../../common/build-error.js";
import { Point2D } from "../../../../math/point.js";
import { Geometry } from "../../../../oc/geometry.js";
import { fitArcThroughEndpoints } from "../../arc-fit.js";
import { SketchSolverContext } from "../solver-context.js";
import type { MacroProducer } from "./finalize.js";
import type { Sketch } from "../../sketch.js";
import type { ConstraintSpec, PointRole } from "../../../../sketch-solver/index.js";

/** One sub-entity of a macro recipe, before registration.
 * Params: line [sx,sy,ex,ey]; arc [cx,cy,sx,sy,ex,ey] (radius derived). */
export type MacroEntityDef = {
  slot: string;
  kind: 'line' | 'arc';
  params: number[];
  /** Arc sweep display flag (the solver has no sweep param). */
  cw?: boolean;
};

type RegisteredEntity = { entityId: number; kind: 'line' | 'arc'; cw: boolean };

export abstract class MacroShapeBase extends GeometrySceneObject implements MacroProducer {

  private _ctx: SketchSolverContext | null = null;
  private _stillOpen: (() => boolean) | null = null;
  private _finalized = false;
  private _finalizeError: string | null = null;
  private _entities = new Map<string, RegisteredEntity>();

  /** Every slot this shape can ever expose, in a FIXED order — the
   * ordinal feeds deterministic constraint placeholder ids. */
  abstract canonicalSlots(): string[];

  /** Throw on invalid argument/modifier combinations (finalize stashes
   * the message as this statement's build error). */
  protected abstract validateArgs(): void;

  /** The recipe geometry from the current args + modifiers (pure). */
  protected abstract computeEntities(): MacroEntityDef[];

  /** The shape's internal rules, over the registered entity ids. */
  protected abstract computeRules(entityId: (slot: string) => number): ConstraintSpec[];

  /** Shape-specific payload config (authored guesses for write-back). */
  protected abstract serializeConfig(): Record<string, unknown>;

  /** Statement-speak for a slot that does not exist on this instance
   * (e.g. a corner arc without `.radius()`). */
  protected missingSlotMessage(slot: string): string {
    return `${this.getType()}() has no '${slot}' edge`;
  }

  /** Called by the command factory right after addSceneObject.
   * `stillOpen` reports whether the owning sketch callback is still the
   * active one — modifiers are only legal while it is. */
  register(sk: Sketch, stillOpen: () => boolean): void {
    const ctx = sk.solver();
    if (!ctx) {
      return;
    }
    this._ctx = ctx;
    this._stillOpen = stillOpen;
  }

  /** Modifier guard: chained calls after the sketch callback closed (or
   * after finalize) would silently miss the solve — refuse loudly. */
  protected assertMutable(what: string): void {
    if (this._finalized || (this._stillOpen !== null && !this._stillOpen())) {
      throw new Error(
        `${what}: the sketch has closed — chain shape modifiers inside the sketch callback`,
      );
    }
  }

  /**
   * Pre-solve registration (idempotent): validate, register the recipe
   * entities under this statement, add the internal rows. Errors stash
   * for the build slot — a bad macro must not abort the sketch's solve.
   */
  finalizeMacro(): void {
    if (this._finalized) {
      return;
    }
    this._finalized = true;
    if (!this._ctx) {
      return; // outside a sketch — build() reports it
    }
    try {
      this.validateArgs();
      for (const def of this.computeEntities()) {
        const p = def.params;
        const entityId = def.kind === 'line'
          ? this._ctx.addLine(this, p[0], p[1], p[2], p[3])
          : this._ctx.addArc(this, p[0], p[1], p[2], p[3], p[4], p[5]);
        this._entities.set(def.slot, { entityId, kind: def.kind, cw: def.cw === true });
      }
      for (const spec of this.computeRules((slot) => this.requireEntity(slot, this.getType()).entityId)) {
        this._ctx.addInternalConstraint(this, spec);
      }
    } catch (error) {
      this._finalizeError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Stable ordinal of a slot for placeholder-id derivation. */
  slotOrdinal(slot: string): number {
    const index = this.canonicalSlots().indexOf(slot);
    return index >= 0 ? index : this.canonicalSlots().length;
  }

  /**
   * Resolve a slot to its registered solver entity id — deferred
   * constraint resolution (runs after the pre-solve pass).
   */
  macroEntityId(slot: string, what: string): number {
    if (!this._ctx) {
      throw new Error(`${what}: ${this.getType()}() must be written inside a sketch`);
    }
    this.finalizeMacro();
    if (this._finalizeError) {
      throw new Error(`${what}: ${this.getType()}() failed — ${this._finalizeError}`);
    }
    return this.requireEntity(slot, what).entityId;
  }

  /**
   * Current position of a slot's named point: the recipe guess before
   * registration, the (solved) solver params after.
   */
  slotPointValue(slot: string, role: PointRole): Point2D {
    const registered = this._entities.get(slot);
    if (registered && this._ctx) {
      return pointFromParams(this._ctx.entityParams(registered.entityId), registered.kind, role, slot);
    }
    const def = this.computeEntities().find(d => d.slot === slot);
    if (!def) {
      throw new Error(this.missingSlotMessage(slot));
    }
    if (def.kind === 'line') {
      return pointFromParams(def.params, 'line', role, slot);
    }
    // Def layout [cx,cy,sx,sy,ex,ey] → solver layout [cx,cy,r,sx,sy,ex,ey].
    const [cx, cy, sx, sy, ex, ey] = def.params;
    const r = (Math.hypot(sx - cx, sy - cy) + Math.hypot(ex - cx, ey - cy)) / 2;
    return pointFromParams([cx, cy, r, sx, sy, ex, ey], 'arc', role, slot);
  }

  build(): void {
    const sk = this.sketch;
    if (!sk || !this._ctx) {
      throw new BuildError(
        `${this.getType()}() must be written inside a sketch`,
        'wrap the statement in sketch(plane, callback)',
      );
    }
    sk.ensureSolvedForBuild();
    if (this._finalizeError) {
      throw new BuildError(this._finalizeError);
    }
    const diagnosed = this._ctx.statementError(this);
    if (diagnosed) {
      this.setError(diagnosed);
    }

    const plane = sk.getPlane();
    const solvedState: Record<string, number[]> = {};
    for (const [slot, rec] of this._entities) {
      const params = this._ctx.entityParams(rec.entityId);
      solvedState[slot] = params;
      if (rec.kind === 'line') {
        const start = new Point2D(params[0], params[1]);
        const end = new Point2D(params[2], params[3]);
        const segment = Geometry.makeSegment(plane.localToWorld(start), plane.localToWorld(end));
        this.addShape(Geometry.makeEdge(segment));
      } else {
        const start = new Point2D(params[3], params[4]);
        const end = new Point2D(params[5], params[6]);
        const center = new Point2D(params[0], params[1]);
        const { edge } = fitArcThroughEndpoints(plane, start, end, center, rec.cw);
        this.addShape(edge);
      }
    }
    this.setState('solved', solvedState);
  }

  serialize() {
    const solved = this.getState('solved') as Record<string, number[]> | undefined;
    return {
      macro: {
        shape: this.getType(),
        ...this.serializeConfig(),
      },
      entities: [...this._entities].map(([slot, rec]) => ({
        slot,
        entityId: rec.entityId,
        kind: rec.kind,
        cw: rec.cw,
        params: solved?.[slot] ?? this.guessParams(slot),
      })),
    };
  }

  private guessParams(slot: string): number[] {
    const def = this.computeEntities().find(d => d.slot === slot);
    if (!def) {
      return [];
    }
    if (def.kind === 'line') {
      return [...def.params];
    }
    const [cx, cy, sx, sy, ex, ey] = def.params;
    const r = (Math.hypot(sx - cx, sy - cy) + Math.hypot(ex - cx, ey - cy)) / 2;
    return [cx, cy, r, sx, sy, ex, ey];
  }

  private requireEntity(slot: string, what: string): RegisteredEntity {
    const record = this._entities.get(slot);
    if (!record) {
      throw new Error(`${what}: ${this.missingSlotMessage(slot)}`);
    }
    return record;
  }

  protected copyMacroStateTo(copy: MacroShapeBase): void {
    copy._ctx = this._ctx;
    copy._stillOpen = () => false; // copies never accept modifiers
    copy._finalized = this._finalized;
    copy._finalizeError = this._finalizeError;
    copy._entities = new Map(this._entities);
  }

  // NOTE deliberately NO registered-entity comparison in compareTo:
  // SceneCompare runs PRE-BUILD (the P2 rule), when a fresh parse's macro
  // has not finalized yet. The sub-entities are a pure function of the
  // config the subclasses compare + the child order the container-atomic
  // walk already verifies, so config equality is id equality.

  /** Macro sub-entities drag through the UI's solver client like any
   * drawn entity — the internal rows keep the shape a shape. */
  override getSketchInteractivity() {
    return 'draggable' as const;
  }
}

function pointFromParams(params: number[], kind: 'line' | 'arc', role: PointRole, slot: string): Point2D {
  if (kind === 'line') {
    if (role === 'start') {
      return new Point2D(params[0], params[1]);
    }
    if (role === 'end') {
      return new Point2D(params[2], params[3]);
    }
    throw new Error(`'${slot}' is a line — it has no '${role}' point`);
  }
  if (role === 'center') {
    return new Point2D(params[0], params[1]);
  }
  if (role === 'start') {
    return new Point2D(params[3], params[4]);
  }
  return new Point2D(params[5], params[6]);
}
