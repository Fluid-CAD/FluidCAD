// Per-sketch bridge between solved-mode statements and lib/sketch-solver.
// Statements register entities/constraints here at statement time (module
// evaluation); the first solved child's build() triggers the one solve +
// diagnose of the render pass. Diagnostics are translated back into
// statement-keyed errors (file:line speak, never solver ids).

import { SketchSystem, solve, diagnose } from "../../../sketch-solver/index.js";
import { MM_PER_UNIT } from "../../../units/units.js";
import { getActiveUnit } from "../../../units/registry.js";
import type {
  ConstraintSpec,
  EntityKind,
  EntityOptions,
  SketchDiagnostics,
  SketchSolverSystem,
  SolveResult,
} from "../../../sketch-solver/index.js";
import { SceneObject } from "../../../common/scene-object.js";
import { callSiteKey } from "../../../common/call-site.js";

const PARAM_COUNT: Record<EntityKind, number> = { point: 2, line: 4, circle: 3, arc: 7 };

export type SolveSummary = {
  snapshot: SketchSolverSystem;
  /** Error for the sketch row itself — only when the solve failed without
   * naming specific conflicting constraints. */
  sketchError: string | null;
};

export class SketchSolverContext {
  readonly system = new SketchSystem();

  constructor() {
    // Implicit datums: every solved sketch exposes origin + axes as fixed
    // reference entities, registered before any statement entity so param
    // offsets match a UI rebuild from the snapshot.
    this.system.ensureDatums();
  }

  private entityStatements = new Map<number, SceneObject>();
  private constraintStatements = new Map<number, SceneObject>();
  private statementErrors = new Map<SceneObject, string>();
  private deferredConstraints: { resolveNow(): void }[] = [];
  private summary: SolveSummary | null = null;

  // -- registration (statement time; fixed references at pre-solve time) ---

  addPoint(owner: SceneObject, x: number, y: number, opts?: EntityOptions): number {
    const id = this.system.point(x, y, opts);
    this.entityStatements.set(id, owner);
    return id;
  }

  addLine(owner: SceneObject, sx: number, sy: number, ex: number, ey: number, opts?: EntityOptions): number {
    const id = this.system.line(sx, sy, ex, ey, opts);
    this.entityStatements.set(id, owner);
    return id;
  }

  addCircle(owner: SceneObject, cx: number, cy: number, r: number, opts?: EntityOptions): number {
    const id = this.system.circle(cx, cy, r, opts);
    this.entityStatements.set(id, owner);
    return id;
  }

  addArc(owner: SceneObject, cx: number, cy: number, sx: number, sy: number, ex: number, ey: number, opts?: EntityOptions): number {
    const id = this.system.arc(cx, cy, sx, sy, ex, ey, opts);
    this.entityStatements.set(id, owner);
    return id;
  }

  /**
   * INTERNAL affine tie for derived duplicates (2D copy instances): no
   * statement mapping — the record is internal (negative id) and diagnose
   * never names it, so conflicts always surface on user constraints.
   */
  addTransformTie(
    source: number,
    target: number,
    matrix: [number, number, number, number, number, number],
  ): number {
    return this.system.addTransformTie(source, target, matrix);
  }

  /** Throws on resolution/validation errors — callers stash the message as
   * the statement's build error so parsing continues. */
  constrain(owner: SceneObject, spec: ConstraintSpec): number {
    const id = this.system.constrain(spec);
    this.constraintStatements.set(id, owner);
    return id;
  }

  /**
   * INTERNAL constraint row owned by a macro shape statement
   * (fluidcad/shapes): negative id, no badge/timeline presence, not
   * individually deletable. The owner mapping makes a conflicting
   * internal id surface as an error on the macro's own row.
   */
  addInternalConstraint(owner: SceneObject, spec: ConstraintSpec): number {
    const id = this.system.constrainInternal(spec);
    this.constraintStatements.set(id, owner);
    return id;
  }

  /**
   * Queue a constraint whose targets include fixed references (P6): their
   * entity ids only exist after the pre-solve pass builds the projections,
   * so the spec resolves in {@link resolveDeferredConstraints} instead of at
   * statement time. Errors stash on the statement there, exactly as eager
   * registration stashes them.
   */
  queueDeferredConstraint(statement: { resolveNow(): void }): void {
    this.deferredConstraints.push(statement);
  }

  /** Run by the sketch after the reference pre-pass, before the solve. */
  resolveDeferredConstraints(): void {
    const queued = this.deferredConstraints;
    this.deferredConstraints = [];
    for (const statement of queued) {
      statement.resolveNow();
    }
  }

  // -- solve (build time, once per render) --------------------------------

  ensureSolved(): SolveSummary {
    if (this.summary) {
      return this.summary;
    }

    let result: SolveResult | null = null;
    let diagnostics: SketchDiagnostics | null = null;
    let sketchError: string | null = null;

    // Gate on statements, not params — the datums alone (an empty sketch)
    // warrant no solve and no DOF verdict.
    if (this.entityStatements.size > 0 || this.constraintStatements.size > 0) {
      // Build time runs inside withUnit(sketch unit): the solver's mm floors
      // are scaled here so the pure solver never reads the unit registry.
      const lengthScale = MM_PER_UNIT[getActiveUnit()];
      result = solve(this.system, { lengthScale });
      diagnostics = diagnose(this.system, { lengthScale });
      this.attributeConflicts(diagnostics.conflicting);
      if (this.statementErrors.size === 0 && result.outcome !== 'solved') {
        sketchError = result.outcome === 'singular'
          ? 'Sketch constraint system is singular — showing the closest solution'
          : 'Sketch constraints did not converge — showing the closest solution';
      }
    }

    this.summary = {
      snapshot: this.system.snapshot({
        outcome: result?.outcome,
        diagnostics: diagnostics ?? undefined,
      }),
      sketchError,
    };
    return this.summary;
  }

  /** Diagnose-derived error for a statement (entity or constraint), set by
   * ensureSolved. Null before the solve and for clean statements. */
  statementError(stmt: SceneObject): string | null {
    return this.statementErrors.get(stmt) ?? null;
  }

  // -- reads --------------------------------------------------------------

  /** Current params of an entity — guesses before the solve, solved values
   * after (build order guarantees after, via Sketch.ensureSolvedForBuild). */
  entityParams(id: number): number[] {
    const record = this.system.entity(id);
    const values = this.system.values;
    const count = PARAM_COUNT[record.kind];
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = values[record.paramOffset + i];
    }
    return out;
  }

  // -- diagnostics → statements -------------------------------------------

  private attributeConflicts(conflicting: number[]): void {
    if (conflicting.length === 0) {
      return;
    }

    const statements: SceneObject[] = [];
    for (const id of conflicting) {
      const stmt = this.statementFor(id);
      if (stmt && !statements.includes(stmt)) {
        statements.push(stmt);
      }
    }

    for (const stmt of statements) {
      const others = statements.filter(s => s !== stmt).map(s => this.label(s));
      const message = others.length > 0
        ? `Constraint cannot be satisfied — conflicts with ${others.join(', ')}`
        : 'Constraint cannot be satisfied';
      this.statementErrors.set(stmt, message);
    }
  }

  /** Internal (negative) constraint ids map to the owning entity's
   * statement; user ids map to their constraint statement. */
  private statementFor(constraintId: number): SceneObject | null {
    const direct = this.constraintStatements.get(constraintId);
    if (direct) {
      return direct;
    }
    for (const record of this.system.constraints()) {
      if (record.id === constraintId && record.spec.kind === 'arc-consistency') {
        return this.entityStatements.get(record.spec.entity) ?? null;
      }
    }
    return null;
  }

  private label(stmt: SceneObject): string {
    const loc = stmt.getSourceLocation();
    if (!loc) {
      return stmt.getType();
    }
    // N loop iterations share one line — "line 12" alone names N statements,
    // so disambiguate with the 1-based execution ordinal.
    const instance = this.callSiteInstance(stmt);
    return instance === null
      ? `${stmt.getType()} (line ${loc.line})`
      : `${stmt.getType()} (line ${loc.line}, instance ${instance})`;
  }

  /**
   * 1-based ordinal of `stmt` among this context's registered statements
   * sharing its call site, or null when the call site registered only once.
   * Registration order is statement execution order (Map insertion order).
   */
  private callSiteInstance(stmt: SceneObject): number | null {
    const key = callSiteKey(stmt);
    if (!key) {
      return null;
    }
    const seen = new Set<SceneObject>();
    const peers: SceneObject[] = [];
    for (const owner of [...this.entityStatements.values(), ...this.constraintStatements.values()]) {
      if (seen.has(owner)) {
        continue;
      }
      seen.add(owner);
      if (callSiteKey(owner) === key) {
        peers.push(owner);
      }
    }
    if (peers.length < 2) {
      return null;
    }
    const index = peers.indexOf(stmt);
    return index === -1 ? null : index + 1;
  }
}
