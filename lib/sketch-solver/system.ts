// SketchSystem — the param table, entity records, and constraint
// list, plus row compilation. Pure data + closures: no solving here
// (solve.ts) and no diagnostics (diagnose.ts).

import { compileConstraint } from './constraints/index.js';
import type {
  CompiledRow,
  CompileCtx,
  ResolvedCircle,
  ResolvedEllipse,
  ResolvedLine,
  ResolvedPoint,
} from './constraints/types.js';
import {
  ORIGIN_ENTITY,
  X_AXIS_ENTITY,
  Y_AXIS_ENTITY,
  datumNameOf,
} from './types.js';
import type {
  AuxParamRecord,
  ConstraintRecord,
  ConstraintSpec,
  EntityKind,
  EntityRecord,
  SketchDiagnostics,
  SketchSolverSystem,
  SolveOutcome,
  SolverRef,
} from './types.js';

export const PARAM_COUNT: Record<EntityKind, number> = {
  point: 2,
  line: 4,
  circle: 3,
  arc: 7,
  ellipse: 5,
};

/**
 * Which of a NON-fixed entity's params the solve may move — every param of
 * every kind today (an ellipse's radii are dimensioned like a circle's,
 * with radius(el, v, 'x' | 'y')). Kept as the one place a per-param lock
 * would live.
 */
export const FREE_PARAMS: Record<EntityKind, readonly boolean[]> = {
  point: [true, true],
  line: [true, true, true, true],
  circle: [true, true, true],
  arc: [true, true, true, true, true, true, true],
  ellipse: [true, true, true, true, true],
};

export type EntityOptions = {
  /** Explicit id (≥ 0); auto-assigned when omitted. */
  id?: number;
  /** Locked reference geometry: params excluded from the solve. */
  fixed?: boolean;
};

/** Rows for the full system at one structural version. */
export type CompiledSystem = {
  version: number;
  rows: CompiledRow[];
  /** Row index → index into constraints(). */
  rowConstraint: Int32Array;
  /** Per-param: 1 = solvable, 0 = locked (fixed entity, locked radius). */
  freeMask: Uint8Array;
  /** Entity params plus the constraint-owned aux slots appended after
   * them — the length of `values` while this compile is current. */
  paramCount: number;
};

/** A compile-time aux slot's identity: the owning constraint and its
 * ordinal among that constraint's allocations. */
type AuxSlot = { constraint: number; slot: number };

/** The scratch allocator handed to one compile pass. */
type AuxSink = {
  slots: AuxSlot[];
  inits: number[];
};

export class SketchSystem {
  private entityList: EntityRecord[] = [];
  private entityById = new Map<number, EntityRecord>();
  private constraintList: ConstraintRecord[] = [];
  private usedConstraintIds = new Set<number>();
  private guessList: number[] = [];
  private valuesArr = new Float64Array(0);
  private nextEntityId = 0;
  private nextConstraintId = 0;
  private nextInternalId = -1;
  private structuralVersion = 0;
  private compiledCache: CompiledSystem | null = null;
  /**
   * Constraint-owned aux params of the CURRENT compile (a tangency's
   * contact point), laid out after the entity params in `values`. Empty
   * between a structural change and the next compile; their last values
   * wait in `auxCarry` keyed by "constraint:slot" so a recompile (a new
   * statement, a re-locked branch) warm-starts them instead of restarting
   * from the geometric guess.
   */
  private auxSlots: AuxSlot[] = [];
  private auxCarry = new Map<string, number>();

  /**
   * Opaque cache slot for the solve layer (solve plans per
   * glue/drag fingerprint + per-component λ memory; a drag frame
   * uses two plans — drag pass and constraint-projection polish).
   * Owned by solve.ts; typed loosely to keep the dependency
   * one-directional.
   */
  planCache: {
    version: number;
    plans: Map<string, unknown>;
    glue?: { dragKey: string; pairs: unknown; key: string };
  } | null = null;

  // -- entities -----------------------------------------------------------

  point(x: number, y: number, opts: EntityOptions = {}): number {
    return this.addEntity('point', [x, y], opts);
  }

  line(x0: number, y0: number, x1: number, y1: number, opts: EntityOptions = {}): number {
    return this.addEntity('line', [x0, y0, x1, y1], opts);
  }

  circle(cx: number, cy: number, r: number, opts: EntityOptions = {}): number {
    return this.addEntity('circle', [cx, cy, r], opts);
  }

  /**
   * Ellipse with semi-radius rx along its own axis u = (cos θ, sin θ) and
   * ry along v = (−sin θ, cos θ); θ (radians) is the rotation of that RX
   * axis from the sketch x direction. All five params are guesses the
   * constraints drive: radius(el, v, 'x' | 'y') dimensions a semi-radius,
   * horizontal/vertical the rotation. Non-positive radii are the statement
   * layer's error to report: the rows stay finite either way.
   */
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    theta: number,
    opts: EntityOptions = {},
  ): number {
    return this.addEntity('ellipse', [cx, cy, rx, ry, theta], opts);
  }

  /**
   * Arc through start/end around a center. The radius guess is
   * derived from the endpoint distances (literals are guesses — the
   * internal consistency rows reconcile any disagreement). A fixed
   * arc gets no consistency rows: its params are locked, so they
   * could never solve — only surface as bogus redundant/conflicting
   * inert rows in diagnose.
   */
  arc(
    cx: number,
    cy: number,
    sx: number,
    sy: number,
    ex: number,
    ey: number,
    opts: EntityOptions = {},
  ): number {
    const r = (Math.hypot(sx - cx, sy - cy) + Math.hypot(ex - cx, ey - cy)) / 2;
    const id = this.addEntity('arc', [cx, cy, r, sx, sy, ex, ey], opts);
    if (opts.fixed !== true) {
      this.constraintList.push({
        id: this.nextInternalId--,
        internal: true,
        spec: { kind: 'arc-consistency', entity: id },
      });
    }
    return id;
  }

  /**
   * Register the implicit sketch datums — origin point + x/y axis
   * lines — as fixed entities under their reserved negative ids.
   * Idempotent. Call before any statement entity so param offsets stay
   * identical between the kernel system and a UI rebuild from its
   * snapshot (datums first, statements after).
   */
  ensureDatums(): void {
    if (this.entityById.has(ORIGIN_ENTITY)) {
      return;
    }
    this.insertEntity('point', [0, 0], ORIGIN_ENTITY, true);
    this.insertEntity('line', [0, 0, 1, 0], X_AXIS_ENTITY, true);
    this.insertEntity('line', [0, 0, 0, 1], Y_AXIS_ENTITY, true);
  }

  private addEntity(kind: EntityKind, guesses: number[], opts: EntityOptions): number {
    let id: number;
    if (opts.id !== undefined) {
      if (opts.id < 0 || !Number.isInteger(opts.id)) {
        throw new Error(`sketch-solver: entity id must be a non-negative integer, got ${opts.id}`);
      }
      if (this.entityById.has(opts.id)) {
        throw new Error(`sketch-solver: duplicate entity id ${opts.id}`);
      }
      id = opts.id;
      this.nextEntityId = Math.max(this.nextEntityId, id + 1);
    } else {
      while (this.entityById.has(this.nextEntityId)) {
        this.nextEntityId++;
      }
      id = this.nextEntityId++;
    }
    return this.insertEntity(kind, guesses, id, opts.fixed === true);
  }

  private insertEntity(kind: EntityKind, guesses: number[], id: number, fixed: boolean): number {
    this.beforeStructuralChange();
    const record: EntityRecord = {
      id,
      kind,
      fixed,
      paramOffset: this.guessList.length,
    };
    this.entityList.push(record);
    this.entityById.set(id, record);
    this.guessList.push(...guesses);
    this.structuralVersion++;
    return id;
  }

  /**
   * Every structural mutation passes here first: the current compile's
   * aux slots are harvested into the carry map and dropped from `values`,
   * so the entity params are again the whole table when the mutation
   * appends to it. The next compile re-allocates the slots (in constraint
   * order) and restores the carried values.
   */
  private beforeStructuralChange(): void {
    if (this.auxSlots.length === 0) {
      return;
    }
    const entityCount = this.guessList.length;
    if (this.valuesArr.length >= entityCount + this.auxSlots.length) {
      for (let k = 0; k < this.auxSlots.length; k++) {
        const slot = this.auxSlots[k];
        this.auxCarry.set(auxKey(slot.constraint, slot.slot), this.valuesArr[entityCount + k]);
      }
    }
    this.valuesArr = this.valuesArr.slice(0, entityCount);
    this.auxSlots = [];
  }

  // -- constraints --------------------------------------------------------

  /**
   * Add a constraint statement. Resolution errors throw here (at
   * "statement time") — the spec is compiled once against the current
   * guesses and discarded; the solve compiles fresh rows per
   * structural version.
   */
  constrain(spec: ConstraintSpec, id?: number): number {
    let cid: number;
    if (id !== undefined) {
      if (id < 0 || !Number.isInteger(id)) {
        throw new Error(`sketch-solver: constraint id must be a non-negative integer, got ${id}`);
      }
      if (this.usedConstraintIds.has(id)) {
        throw new Error(`sketch-solver: duplicate constraint id ${id}`);
      }
      cid = id;
      this.nextConstraintId = Math.max(this.nextConstraintId, cid + 1);
    } else {
      while (this.usedConstraintIds.has(this.nextConstraintId)) {
        this.nextConstraintId++;
      }
      cid = this.nextConstraintId++;
    }
    let stored = spec;
    if (spec.kind === 'fix' && (spec.x === undefined || spec.y === undefined)) {
      const pt = this.resolvePoint(spec.p, 'fix point');
      const values = this.values;
      stored = { ...spec, x: spec.x ?? values[pt.ix], y: spec.y ?? values[pt.iy] };
    }
    const record: ConstraintRecord = { id: cid, internal: false, spec: stored };
    this.validate(record);
    this.beforeStructuralChange();
    this.constraintList.push(record);
    this.usedConstraintIds.add(cid);
    this.structuralVersion++;
    return cid;
  }

  /** Compile a record once against the current guesses for its
   * resolution/validation errors; rows and aux allocations are discarded. */
  private validate(record: ConstraintRecord): void {
    const scratch: AuxSink = { slots: [], inits: [] };
    compileConstraint(record, this.compileCtx(scratch, { id: record.id }));
  }

  /**
   * INTERNAL constraint row(s) owned by a macro shape statement
   * (fluidcad/shapes): a user-kind spec (coincident, horizontal,
   * tangent, equal, …) stored as an internal record — negative id,
   * no user statement, never individually deletable. Diagnose boosts
   * internal rows so redundancy attribution names USER statements,
   * and a conflicting internal id maps back to the owning macro
   * statement in the context layer. `id` (negative) replays a
   * snapshot record — the UI rebuild path, like transform ties.
   */
  constrainInternal(spec: ConstraintSpec, id?: number): number {
    let cid: number;
    if (id !== undefined) {
      if (id >= 0 || !Number.isInteger(id)) {
        throw new Error(`sketch-solver: internal constraint id must be a negative integer, got ${id}`);
      }
      if (this.constraintList.some((c) => c.id === id)) {
        throw new Error(`sketch-solver: duplicate internal constraint id ${id}`);
      }
      cid = id;
      this.nextInternalId = Math.min(this.nextInternalId, cid - 1);
    } else {
      cid = this.nextInternalId--;
    }
    const record: ConstraintRecord = { id: cid, internal: true, spec };
    this.validate(record);
    this.beforeStructuralChange();
    this.constraintList.push(record);
    this.structuralVersion++;
    return cid;
  }

  /**
   * INTERNAL affine tie: rigidly derive `target` from `source` (same
   * kind) through p' = [[a,b],[c,d]]·p + [tx,ty] with matrix =
   * [a, b, c, d, tx, ty] — the engine-side registration for derived
   * entities (2D copy instances). The target contributes params and
   * an equal number of linear tie rows, so net DOF is unchanged and
   * constraining either side moves both. The record is internal
   * (negative id, like arc-consistency) and diagnose never names it —
   * conflicts/redundancy surface on user constraints. A tied arc's
   * own arc-consistency record is dropped here: the source's
   * consistency rows plus the (similarity-validated) tie imply it,
   * and keeping it would only add inert redundant rows — the same
   * reasoning as fixed arcs in arc(). Rebuilds from a snapshot must
   * therefore replay tie records through this method (not skip them
   * like other internal records), so both sides drop the same rows.
   * Returns the tie's (negative) constraint id.
   */
  addTransformTie(
    source: number,
    target: number,
    matrix: [number, number, number, number, number, number],
  ): number {
    return this.addDerivedTie(target, { kind: 'transform-tie', source, target, matrix: [...matrix] });
  }

  /**
   * INTERNAL reflection tie: rigidly derive `target` as the mirror image
   * of `source` (same kind) across `axis` — a solver LINE entity (a
   * sketched mirror line or a datum axis: the rows carry its params, so
   * the images follow a moving mirror line) or a constant line
   * [sx, sy, ex, ey] in sketch coordinates (a world axis). The engine-side
   * registration for 2D mirror images; the same net-zero-DOF,
   * bidirectional, diagnose-invisible contract as addTransformTie,
   * including the tied arc's dropped consistency record and the replay
   * requirement on snapshot rebuilds. Returns the tie's (negative) id.
   */
  addMirrorTie(
    source: number,
    target: number,
    axis: SolverRef | [number, number, number, number],
  ): number {
    const spec: ConstraintSpec = Array.isArray(axis)
      ? { kind: 'mirror-tie', source, target, axis: [...axis] as [number, number, number, number] }
      : { kind: 'mirror-tie', source, target, axis: { ...axis } };
    return this.addDerivedTie(target, spec);
  }

  private addDerivedTie(target: number, spec: ConstraintSpec): number {
    const record: ConstraintRecord = {
      id: this.nextInternalId--,
      internal: true,
      spec,
    };
    this.validate(record);
    this.beforeStructuralChange();
    if (this.entity(target).kind === 'arc') {
      const idx = this.constraintList.findIndex(
        (c) => c.internal && c.spec.kind === 'arc-consistency' && c.spec.entity === target,
      );
      if (idx >= 0) {
        this.constraintList.splice(idx, 1);
      }
    }
    this.constraintList.push(record);
    this.structuralVersion++;
    return record.id;
  }

  // -- access -------------------------------------------------------------

  /**
   * Live param table (guesses until solved; solve writes back): the
   * entity params, followed — while a compile is current — by its aux
   * slots. Structural changes drop the aux tail (beforeStructuralChange)
   * before the entity part grows, so the entity prefix is always intact.
   */
  get values(): Float64Array {
    const want = this.guessList.length + this.auxSlots.length;
    if (this.valuesArr.length !== want) {
      const next = new Float64Array(want);
      next.set(this.valuesArr.subarray(0, Math.min(this.valuesArr.length, want)));
      for (let i = this.valuesArr.length; i < this.guessList.length; i++) {
        next[i] = this.guessList[i];
      }
      this.valuesArr = next;
    }
    return this.valuesArr;
  }

  /** Entity param count — the layout a snapshot's `params` describes. */
  get paramCount(): number {
    return this.guessList.length;
  }

  /** The aux slots of the current structure with their live values, in
   * slot order (compiling first if a structural change made the last
   * layout stale); empty when no constraint allocates any. */
  auxParams(): AuxParamRecord[] {
    this.compiled();
    const values = this.values;
    const base = this.guessList.length;
    return this.auxSlots.map((slot, k) => ({
      constraint: slot.constraint,
      slot: slot.slot,
      value: values[base + k],
    }));
  }

  /**
   * Seed aux slots from a snapshot (a UI rebuild of the kernel's system):
   * the next compile restores these values instead of the geometric
   * guesses, so the rebuilt system's first solve starts exactly where the
   * kernel's ended. Slots whose constraint no longer allocates are ignored.
   */
  seedAux(records: readonly AuxParamRecord[]): void {
    for (const record of records) {
      this.auxCarry.set(auxKey(record.constraint, record.slot), record.value);
    }
  }

  /** Original statement-time guesses, parallel to `values`. */
  get guesses(): readonly number[] {
    return this.guessList;
  }

  get version(): number {
    return this.structuralVersion;
  }

  entities(): readonly EntityRecord[] {
    return this.entityList;
  }

  constraints(): readonly ConstraintRecord[] {
    return this.constraintList;
  }

  entity(id: number): EntityRecord {
    const record = this.entityById.get(id);
    if (!record) {
      throw new Error(`sketch-solver: unknown entity ${id}`);
    }
    return record;
  }

  /** Reset every entity param to its original guess (aux slots keep
   * their values — the next solve re-seats them). */
  resetToGuesses(): void {
    this.values.set(this.guessList);
  }

  /**
   * Overwrite an entity's guess params — statement-time modifier chains
   * (e.g. `text().at([x, y])`) refining a position captured at
   * registration. Statement time only: it runs before the first solve,
   * so no compiled rows or captured values exist yet to go stale.
   */
  setGuess(id: number, params: number[]): void {
    const record = this.entity(id);
    const count = PARAM_COUNT[record.kind];
    if (params.length !== count) {
      throw new Error(`sketch-solver: ${record.kind} takes ${count} params, got ${params.length}`);
    }
    for (let i = 0; i < count; i++) {
      this.guessList[record.paramOffset + i] = params[i];
      if (record.paramOffset + i < this.valuesArr.length) {
        this.valuesArr[record.paramOffset + i] = params[i];
      }
    }
  }

  /** Param indices of a point ref — drag callers and tests. */
  pointIndices(ref: SolverRef): ResolvedPoint {
    return this.resolvePoint(ref, 'point ref');
  }

  pointValue(ref: SolverRef): { x: number; y: number } {
    const pt = this.resolvePoint(ref, 'point ref');
    const values = this.values;
    return { x: values[pt.ix], y: values[pt.iy] };
  }

  // -- compilation --------------------------------------------------------

  /** Rows for the current structure, cached per structural version.
   * Branch signs are locked from the values at compile time. */
  compiled(): CompiledSystem {
    if (this.compiledCache && this.compiledCache.version === this.structuralVersion) {
      return this.compiledCache;
    }
    // A stale compile's aux tail (invalidateCompile without a structural
    // change) is harvested like any other: the fresh pass re-allocates.
    this.beforeStructuralChange();
    const sink: AuxSink = { slots: [], inits: [] };
    const current = { id: 0 };
    const ctx = this.compileCtx(sink, current);
    const rows: CompiledRow[] = [];
    const owners: number[] = [];
    for (let c = 0; c < this.constraintList.length; c++) {
      const record = this.constraintList[c];
      current.id = record.id;
      for (const row of compileConstraint(record, ctx)) {
        rows.push(row);
        owners.push(c);
      }
    }
    // Install the aux slots: values carried by identity where a previous
    // compile had the slot, the geometric init otherwise.
    const entityCount = this.guessList.length;
    const entityValues = this.values; // entity part only (auxSlots is empty)
    this.auxSlots = sink.slots;
    const next = new Float64Array(entityCount + sink.slots.length);
    next.set(entityValues.subarray(0, entityCount));
    for (let k = 0; k < sink.slots.length; k++) {
      const slot = sink.slots[k];
      next[entityCount + k] = this.auxCarry.get(auxKey(slot.constraint, slot.slot)) ?? sink.inits[k];
    }
    this.valuesArr = next;

    const freeMask = new Uint8Array(next.length);
    for (const entity of this.entityList) {
      if (entity.fixed) {
        continue;
      }
      const free = FREE_PARAMS[entity.kind];
      for (let i = 0; i < free.length; i++) {
        freeMask[entity.paramOffset + i] = free[i] ? 1 : 0;
      }
    }
    freeMask.fill(1, entityCount);
    this.compiledCache = {
      version: this.structuralVersion,
      rows,
      rowConstraint: Int32Array.from(owners),
      freeMask,
      paramCount: next.length,
    };
    return this.compiledCache;
  }

  /** Force branch signs to re-lock from the current values on the
   * next solve (normally they persist per structural version). The aux
   * tail is harvested here, so a seedAux() right after wins over the
   * values the stale layout held. */
  invalidateCompile(): void {
    this.beforeStructuralChange();
    this.compiledCache = null;
    this.planCache = null;
    this.structuralVersion++;
  }

  /** All point-role slots (for value-coincidence gluing). */
  pointSlots(): { entity: number; role: string; ix: number; iy: number }[] {
    const slots: { entity: number; role: string; ix: number; iy: number }[] = [];
    for (const e of this.entityList) {
      const o = e.paramOffset;
      switch (e.kind) {
        case 'point':
          slots.push({ entity: e.id, role: 'point', ix: o, iy: o + 1 });
          break;
        case 'line':
          slots.push({ entity: e.id, role: 'start', ix: o, iy: o + 1 });
          slots.push({ entity: e.id, role: 'end', ix: o + 2, iy: o + 3 });
          break;
        case 'circle':
          slots.push({ entity: e.id, role: 'center', ix: o, iy: o + 1 });
          break;
        case 'arc':
          slots.push({ entity: e.id, role: 'center', ix: o, iy: o + 1 });
          slots.push({ entity: e.id, role: 'start', ix: o + 3, iy: o + 4 });
          slots.push({ entity: e.id, role: 'end', ix: o + 5, iy: o + 6 });
          break;
        case 'ellipse':
          slots.push({ entity: e.id, role: 'center', ix: o, iy: o + 1 });
          break;
      }
    }
    return slots;
  }

  snapshot(extras?: {
    outcome?: SolveOutcome;
    diagnostics?: SketchDiagnostics;
  }): SketchSolverSystem {
    const aux = this.auxParams();
    return {
      entities: this.entityList.map((e) => ({ ...e })),
      constraints: this.constraintList.map((c) => ({ ...c, spec: { ...c.spec } })),
      params: Array.from(this.values.subarray(0, this.guessList.length)),
      ...(aux.length > 0 ? { aux } : {}),
      outcome: extras?.outcome ?? null,
      dof: extras?.diagnostics ? extras.diagnostics.dof : null,
      conflicting: extras?.diagnostics ? [...extras.diagnostics.conflicting] : [],
      redundant: extras?.diagnostics ? [...extras.diagnostics.redundant] : [],
      underconstrainedEntities: extras?.diagnostics
        ? [...extras.diagnostics.underconstrainedEntities]
        : null,
    };
  }

  // -- resolution ---------------------------------------------------------

  /**
   * @param sink Receives the aux allocations of this pass — the real
   *   compile's sink becomes the installed layout; a validation pass hands
   *   a scratch one and discards it.
   * @param current The record being compiled (mutable: the compile loop
   *   advances it), stamped on the slots it allocates.
   */
  private compileCtx(sink: AuxSink, current: { id: number }): CompileCtx {
    // Junction index for tangency-at-endpoint detection: coincident
    // records keyed by the point's ix param. INTERNAL coincidents (macro
    // shape corner junctions) count too — a macro's internal tangent rows
    // must compile in junction form at those corners, exactly like user
    // tangents at user coincidents (P1 finding: the distance form is
    // rank-deficient at a coincident endpoint).
    const linked = new Map<number, Set<number>>();
    const onEntity = new Map<number, Set<number>>();
    for (const record of this.constraintList) {
      const spec = record.spec;
      if (spec.kind !== 'coincident') {
        continue;
      }
      const aIsPoint = this.entity(spec.a.entity).kind === 'point' || spec.a.point !== undefined;
      const bIsPoint = this.entity(spec.b.entity).kind === 'point' || spec.b.point !== undefined;
      if (aIsPoint && bIsPoint) {
        const a = this.resolvePoint(spec.a, 'coincident');
        const b = this.resolvePoint(spec.b, 'coincident');
        addLink(linked, a.ix, b.ix);
        addLink(linked, b.ix, a.ix);
      } else if (aIsPoint || bIsPoint) {
        const p = this.resolvePoint(aIsPoint ? spec.a : spec.b, 'coincident');
        addLink(onEntity, p.ix, (aIsPoint ? spec.b : spec.a).entity);
      }
    }
    const entityCount = this.guessList.length;
    return {
      guess: this.values,
      arePointsLinked: (a, b) => linked.get(a.ix)?.has(b.ix) === true,
      isPointOnEntity: (p, entityId) => onEntity.get(p.ix)?.has(entityId) === true,
      kindOf: (id) => this.entity(id).kind,
      point: (ref, what) => this.resolvePoint(ref, what),
      line: (ref, what) => this.resolveLine(ref, what),
      circle: (ref, what) => this.resolveCircle(ref, what),
      ellipse: (ref, what) => this.resolveEllipse(ref, what),
      isPoint: (ref) => this.entity(ref.entity).kind === 'point' || ref.point !== undefined,
      isLine: (ref) => ref.point === undefined && this.entity(ref.entity).kind === 'line',
      isCircle: (ref) => {
        const kind = this.entity(ref.entity).kind;
        return ref.point === undefined && (kind === 'circle' || kind === 'arc');
      },
      isEllipse: (ref) => ref.point === undefined && this.entity(ref.entity).kind === 'ellipse',
      aux: (init) => {
        const indices: number[] = [];
        const first = sink.slots.filter((s) => s.constraint === current.id).length;
        for (let i = 0; i < init.length; i++) {
          indices.push(entityCount + sink.slots.length);
          sink.slots.push({ constraint: current.id, slot: first + i });
          sink.inits.push(init[i]);
        }
        return indices;
      },
    };
  }

  private resolvePoint(ref: SolverRef, what: string): ResolvedPoint {
    const e = this.entity(ref.entity);
    const o = e.paramOffset;
    const role = ref.point;
    switch (e.kind) {
      case 'point':
        if (role !== undefined) {
          throw new Error(`${what}: point entity ${e.id} has no '${role}' point`);
        }
        return { ix: o, iy: o + 1 };
      case 'line':
        if (role === 'start') {
          return { ix: o, iy: o + 1 };
        }
        if (role === 'end') {
          return { ix: o + 2, iy: o + 3 };
        }
        break;
      case 'circle':
        if (role === 'center') {
          return { ix: o, iy: o + 1 };
        }
        break;
      case 'arc':
        if (role === 'center') {
          return { ix: o, iy: o + 1 };
        }
        if (role === 'start') {
          return { ix: o + 3, iy: o + 4 };
        }
        if (role === 'end') {
          return { ix: o + 5, iy: o + 6 };
        }
        break;
      case 'ellipse':
        if (role === 'center') {
          return { ix: o, iy: o + 1 };
        }
        break;
    }
    throw new Error(
      `${what}: ${entityLabel(e.kind, e.id)} does not resolve to a point` +
        (role !== undefined ? ` via role '${role}'` : ' (missing point role)'),
    );
  }

  private resolveLine(ref: SolverRef, what: string): ResolvedLine {
    const e = this.entity(ref.entity);
    if (e.kind !== 'line' || ref.point !== undefined) {
      throw new Error(`${what}: expected a line entity ref, got ${describeRef(e.kind, ref)}`);
    }
    const o = e.paramOffset;
    return { sx: o, sy: o + 1, ex: o + 2, ey: o + 3 };
  }

  private resolveCircle(ref: SolverRef, what: string): ResolvedCircle {
    const e = this.entity(ref.entity);
    if (e.kind === 'ellipse' && ref.point === undefined) {
      throw new Error(
        `${what}: an ellipse has two semi-radii — dimension one with radius(el, value, 'x' | 'y')`,
      );
    }
    if ((e.kind !== 'circle' && e.kind !== 'arc') || ref.point !== undefined) {
      throw new Error(
        `${what}: expected a circle or arc entity ref, got ${describeRef(e.kind, ref)}`,
      );
    }
    const o = e.paramOffset;
    return { cx: o, cy: o + 1, r: o + 2 };
  }

  private resolveEllipse(ref: SolverRef, what: string): ResolvedEllipse {
    const e = this.entity(ref.entity);
    if (e.kind !== 'ellipse' || ref.point !== undefined) {
      throw new Error(`${what}: expected an ellipse entity ref, got ${describeRef(e.kind, ref)}`);
    }
    const o = e.paramOffset;
    return { cx: o, cy: o + 1, rx: o + 2, ry: o + 3, th: o + 4 };
  }
}

function auxKey(constraint: number, slot: number): string {
  return `${constraint}:${slot}`;
}

/** Statement-speak entity naming for resolution errors — datums get
 * their names, never a raw negative id (cross-cutting rule 6). */
function entityLabel(kind: EntityKind, id: number): string {
  const datum = datumNameOf(id);
  if (datum === 'origin') {
    return 'the sketch origin';
  }
  if (datum === 'x-axis') {
    return 'the sketch x-axis';
  }
  if (datum === 'y-axis') {
    return 'the sketch y-axis';
  }
  return `${kind} entity ${id}`;
}

function addLink(map: Map<number, Set<number>>, key: number, value: number): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function describeRef(kind: EntityKind, ref: SolverRef): string {
  const label = entityLabel(kind, ref.entity);
  return ref.point !== undefined ? `${label} role '${ref.point}'` : label;
}
