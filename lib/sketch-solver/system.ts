// SketchSystem — the param table, entity records, and constraint
// list, plus row compilation. Pure data + closures: no solving here
// (solve.ts) and no diagnostics (diagnose.ts).

import { compileConstraint } from './constraints/index.js';
import type {
  CompiledRow,
  CompileCtx,
  ResolvedCircle,
  ResolvedLine,
  ResolvedPoint,
} from './constraints/types.js';
import type {
  ConstraintRecord,
  ConstraintSpec,
  EntityKind,
  EntityRecord,
  SketchDiagnostics,
  SketchSolverSystem,
  SolveOutcome,
  SolverRef,
} from './types.js';

export const PARAM_COUNT: Record<EntityKind, number> = { point: 2, line: 4, circle: 3, arc: 7 };

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
  /** Per-param: 1 = solvable, 0 = locked (fixed entity). */
  freeMask: Uint8Array;
  paramCount: number;
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
   * Arc through start/end around a center. The radius guess is
   * derived from the endpoint distances (literals are guesses — the
   * internal consistency rows reconcile any disagreement).
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
    this.constraintList.push({
      id: this.nextInternalId--,
      internal: true,
      spec: { kind: 'arc-consistency', entity: id },
    });
    return id;
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
    const record: EntityRecord = {
      id,
      kind,
      fixed: opts.fixed === true,
      paramOffset: this.guessList.length,
    };
    this.entityList.push(record);
    this.entityById.set(id, record);
    this.guessList.push(...guesses);
    this.structuralVersion++;
    return id;
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
    compileConstraint(record, this.compileCtx()); // validate eagerly, discard rows
    this.constraintList.push(record);
    this.usedConstraintIds.add(cid);
    this.structuralVersion++;
    return cid;
  }

  // -- access -------------------------------------------------------------

  /** Live param table (guesses until solved; solve writes back). */
  get values(): Float64Array {
    if (this.valuesArr.length !== this.guessList.length) {
      const next = new Float64Array(this.guessList.length);
      next.set(this.valuesArr);
      for (let i = this.valuesArr.length; i < next.length; i++) {
        next[i] = this.guessList[i];
      }
      this.valuesArr = next;
    }
    return this.valuesArr;
  }

  get paramCount(): number {
    return this.guessList.length;
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

  /** Reset every param to its original guess. */
  resetToGuesses(): void {
    this.values.set(this.guessList);
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
    const ctx = this.compileCtx();
    const rows: CompiledRow[] = [];
    const owners: number[] = [];
    for (let c = 0; c < this.constraintList.length; c++) {
      for (const row of compileConstraint(this.constraintList[c], ctx)) {
        rows.push(row);
        owners.push(c);
      }
    }
    const freeMask = new Uint8Array(this.guessList.length);
    for (const entity of this.entityList) {
      if (!entity.fixed) {
        freeMask.fill(1, entity.paramOffset, entity.paramOffset + PARAM_COUNT[entity.kind]);
      }
    }
    this.compiledCache = {
      version: this.structuralVersion,
      rows,
      rowConstraint: Int32Array.from(owners),
      freeMask,
      paramCount: this.guessList.length,
    };
    return this.compiledCache;
  }

  /** Force branch signs to re-lock from the current values on the
   * next solve (normally they persist per structural version). */
  invalidateCompile(): void {
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
      }
    }
    return slots;
  }

  snapshot(extras?: {
    outcome?: SolveOutcome;
    diagnostics?: SketchDiagnostics;
  }): SketchSolverSystem {
    return {
      entities: this.entityList.map((e) => ({ ...e })),
      constraints: this.constraintList.map((c) => ({ ...c, spec: { ...c.spec } })),
      params: Array.from(this.values),
      outcome: extras?.outcome ?? null,
      dof: extras?.diagnostics ? extras.diagnostics.dof : null,
      conflicting: extras?.diagnostics ? [...extras.diagnostics.conflicting] : [],
      redundant: extras?.diagnostics ? [...extras.diagnostics.redundant] : [],
    };
  }

  // -- resolution ---------------------------------------------------------

  private compileCtx(): CompileCtx {
    // Junction index for tangency-at-endpoint detection: user
    // coincident statements, keyed by the point's ix param.
    const linked = new Map<number, Set<number>>();
    const onEntity = new Map<number, Set<number>>();
    for (const record of this.constraintList) {
      const spec = record.spec;
      if (record.internal || spec.kind !== 'coincident') {
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
    return {
      guess: this.values,
      arePointsLinked: (a, b) => linked.get(a.ix)?.has(b.ix) === true,
      isPointOnEntity: (p, entityId) => onEntity.get(p.ix)?.has(entityId) === true,
      kindOf: (id) => this.entity(id).kind,
      point: (ref, what) => this.resolvePoint(ref, what),
      line: (ref, what) => this.resolveLine(ref, what),
      circle: (ref, what) => this.resolveCircle(ref, what),
      isPoint: (ref) => this.entity(ref.entity).kind === 'point' || ref.point !== undefined,
      isLine: (ref) => ref.point === undefined && this.entity(ref.entity).kind === 'line',
      isCircle: (ref) => {
        const kind = this.entity(ref.entity).kind;
        return ref.point === undefined && (kind === 'circle' || kind === 'arc');
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
    }
    throw new Error(
      `${what}: ${e.kind} entity ${e.id} does not resolve to a point` +
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
    if ((e.kind !== 'circle' && e.kind !== 'arc') || ref.point !== undefined) {
      throw new Error(
        `${what}: expected a circle or arc entity ref, got ${describeRef(e.kind, ref)}`,
      );
    }
    const o = e.paramOffset;
    return { cx: o, cy: o + 1, r: o + 2 };
  }
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
  return ref.point !== undefined ? `${kind} entity ${ref.entity} role '${ref.point}'` : `${kind} entity ${ref.entity}`;
}
