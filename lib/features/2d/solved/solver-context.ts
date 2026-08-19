// Per-sketch bridge between solved-mode statements and lib/sketch-solver.
// Statements register entities/constraints here at statement time (module
// evaluation); the first solved child's build() triggers the one solve +
// diagnose of the render pass. Diagnostics are translated back into
// statement-keyed errors (file:line speak, never solver ids).

import { SketchSystem, solve, diagnose } from "../../../sketch-solver/index.js";
import type {
  ConstraintSpec,
  EntityKind,
  SketchDiagnostics,
  SketchSolverSystem,
  SolveResult,
} from "../../../sketch-solver/index.js";
import { SceneObject } from "../../../common/scene-object.js";

const PARAM_COUNT: Record<EntityKind, number> = { point: 2, line: 4, circle: 3, arc: 7 };

export type SolveSummary = {
  snapshot: SketchSolverSystem;
  /** Error for the sketch row itself — only when the solve failed without
   * naming specific conflicting constraints. */
  sketchError: string | null;
};

export class SketchSolverContext {
  readonly system = new SketchSystem();

  private entityStatements = new Map<number, SceneObject>();
  private constraintStatements = new Map<number, SceneObject>();
  private statementErrors = new Map<SceneObject, string>();
  private summary: SolveSummary | null = null;

  // -- registration (statement time) --------------------------------------

  addPoint(owner: SceneObject, x: number, y: number): number {
    const id = this.system.point(x, y);
    this.entityStatements.set(id, owner);
    return id;
  }

  addLine(owner: SceneObject, sx: number, sy: number, ex: number, ey: number): number {
    const id = this.system.line(sx, sy, ex, ey);
    this.entityStatements.set(id, owner);
    return id;
  }

  addCircle(owner: SceneObject, cx: number, cy: number, r: number): number {
    const id = this.system.circle(cx, cy, r);
    this.entityStatements.set(id, owner);
    return id;
  }

  addArc(owner: SceneObject, cx: number, cy: number, sx: number, sy: number, ex: number, ey: number): number {
    const id = this.system.arc(cx, cy, sx, sy, ex, ey);
    this.entityStatements.set(id, owner);
    return id;
  }

  /** Throws on resolution/validation errors — callers stash the message as
   * the statement's build error so parsing continues. */
  constrain(owner: SceneObject, spec: ConstraintSpec): number {
    const id = this.system.constrain(spec);
    this.constraintStatements.set(id, owner);
    return id;
  }

  // -- solve (build time, once per render) --------------------------------

  ensureSolved(): SolveSummary {
    if (this.summary) {
      return this.summary;
    }

    let result: SolveResult | null = null;
    let diagnostics: SketchDiagnostics | null = null;
    let sketchError: string | null = null;

    if (this.system.paramCount > 0) {
      result = solve(this.system);
      diagnostics = diagnose(this.system);
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
    return loc ? `${stmt.getType()} (line ${loc.line})` : stmt.getType();
  }
}
