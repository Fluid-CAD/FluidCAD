// Public data model of the 2D sketch constraint solver.
//
// lib/sketch-solver/ is pure TS: it may import only its own modules
// and lib/solver-core/ (enforced by
// lib/tests/sketch-solver/purity.test.ts), so the same engine runs in
// the kernel (Node, P2) and the browser (P4 drag loop). Everything in
// this file is JSON-serializable — it is the shape that rides the
// render payload to the UI.

export type EntityKind = 'point' | 'line' | 'circle' | 'arc';

export type PointRole = 'start' | 'end' | 'center';

/**
 * Sketch datums — the implicit fixed reference entities every solved
 * sketch registers up front (SketchSystem.ensureDatums): the origin
 * point at local (0,0) and the x/y axis lines along the plane's u/v
 * directions. Reserved negative ids keep the statement-entity range
 * (≥ 0) untouched; the axis lines carry a unit guess extent and act
 * as infinite lines in every constraint that treats lines as
 * carriers.
 */
export type DatumName = 'origin' | 'x-axis' | 'y-axis';

export const ORIGIN_ENTITY = -1;
export const X_AXIS_ENTITY = -2;
export const Y_AXIS_ENTITY = -3;

export const DATUM_ENTITY_IDS: Record<DatumName, number> = {
  origin: ORIGIN_ENTITY,
  'x-axis': X_AXIS_ENTITY,
  'y-axis': Y_AXIS_ENTITY,
};

export function datumNameOf(entityId: number): DatumName | null {
  switch (entityId) {
    case ORIGIN_ENTITY:
      return 'origin';
    case X_AXIS_ENTITY:
      return 'x-axis';
    case Y_AXIS_ENTITY:
      return 'y-axis';
    default:
      return null;
  }
}

/**
 * Reference to an entity or one of its points. Without `point` it
 * names the entity itself (a point entity doubles as its own point);
 * with `point` it names a vertex: line start/end, circle center, arc
 * center/start/end.
 */
export type SolverRef = { entity: number; point?: PointRole };

export const start = (entity: number): SolverRef => ({ entity, point: 'start' });
export const end = (entity: number): SolverRef => ({ entity, point: 'end' });
export const center = (entity: number): SolverRef => ({ entity, point: 'center' });
export const entityRef = (entity: number): SolverRef => ({ entity });

/**
 * Constraint catalog v1 (research §5). Residual dimensions in
 * parentheses. Angles are radians here — degree conversion is the
 * statement layer's job (P2). All literals in the owning entities are
 * guesses; sign/branch choices (tangency side, distance side,
 * internal vs external tangency) are locked from the guesses at
 * compile time, so warm-started re-solves can never flip branches.
 */
export type ConstraintSpec =
  /** Point–point (2) or point-on-line / point-on-circle-or-arc (1),
   * chosen by what the refs resolve to. Point-on-line means the
   * infinite line; point-on-circle means the full circle. */
  | { kind: 'coincident'; a: SolverRef; b: SolverRef }
  /** One line (1) or a point pair (1). */
  | { kind: 'horizontal'; a: SolverRef; b?: SolverRef }
  | { kind: 'vertical'; a: SolverRef; b?: SolverRef }
  /** Line–line (1). */
  | { kind: 'parallel'; a: SolverRef; b: SolverRef }
  /** Line–line (1). */
  | { kind: 'perpendicular'; a: SolverRef; b: SolverRef }
  /** Counterclockwise angle from line a's oriented direction to line
   * b's, radians, [0, 2π) (1). A bare line ref (or its 'end' point)
   * orients start→end; a 'start' point ref reverses it — the four
   * sectors at the lines' intersection are all expressible with a
   * positive value. */
  | { kind: 'angle'; a: SolverRef; b: SolverRef; value: number }
  /** Line–circle/arc (1) or circle–circle (1); branch from guesses. */
  | { kind: 'tangent'; a: SolverRef; b: SolverRef }
  /**
   * Distance dimension (1). Forms by resolution: point–point
   * (`axis` optionally measures along x or y only, side-locked from
   * the guess), point–line (side-locked perpendicular distance),
   * point–circle/arc (distance to the circumference), line–line
   * (distance from b's midpoint to a's infinite line — pair with
   * `parallel` for the parallel-lines dimension), line–circle/arc
   * (perpendicular distance from the center minus the radius; side
   * and outside/crossing locked from the guess), circle–circle
   * (gap between circumferences; containment vs external from the
   * guess). `tangency: 'max'` measures to the FAR side of any
   * circle/arc in the pair (SolidWorks arc-condition max); absent or
   * 'min' is the near side. Requires a circle/arc reference.
   */
  | { kind: 'distance'; a: SolverRef; b: SolverRef; value: number; axis?: 'x' | 'y'; tangency?: 'min' | 'max' }
  | { kind: 'radius'; a: SolverRef; value: number }
  | { kind: 'diameter'; a: SolverRef; value: number }
  /** Equal line lengths or equal radii (1 per pair). `others` extends the
   * equality to further entities of the same family — each is equated to
   * `a`, one residual row apiece. */
  | { kind: 'equal'; a: SolverRef; b: SolverRef; others?: SolverRef[] }
  /** Circle/arc centers coincide (2). */
  | { kind: 'concentric'; a: SolverRef; b: SolverRef }
  /** Both endpoints of line b on the infinite line of a (2). */
  | { kind: 'collinear'; a: SolverRef; b: SolverRef }
  /** Point p is the midpoint of line l (2). */
  | { kind: 'midpoint'; p: SolverRef; l: SolverRef }
  /** Points a and b mirror across line l (2). */
  | { kind: 'symmetric'; a: SolverRef; b: SolverRef; l: SolverRef }
  /**
   * Anchor a point at (x, y) (2). When x/y are omitted at constrain()
   * time they are captured from the current guess and stored, so the
   * record stays serializable and deterministic.
   */
  | { kind: 'fix'; p: SolverRef; x?: number; y?: number }
  /**
   * Internal (auto-added per arc): |start−center| = r and
   * |end−center| = r (2). Never user-authored; carries a negative id.
   */
  | { kind: 'arc-consistency'; entity: number };

export type ConstraintKind = ConstraintSpec['kind'];

/** A constraint as stored/serialized: spec plus identity. Internal
 * records (arc-consistency) carry negative auto-assigned ids; user
 * ids are ≥ 0. */
export type ConstraintRecord = {
  id: number;
  internal: boolean;
  spec: ConstraintSpec;
};

export type EntityRecord = {
  id: number;
  kind: EntityKind;
  /** Locked reference geometry (P6 project()/intersect() outputs):
   * params present but excluded from the solve. */
  fixed: boolean;
  /** Offset of this entity's params in the flat param table.
   * Layouts: point [x,y]; line [sx,sy,ex,ey]; circle [cx,cy,r];
   * arc [cx,cy,r,sx,sy,ex,ey]. */
  paramOffset: number;
};

export type SolveOutcome = 'solved' | 'didnt-converge' | 'singular';

export type ComponentSolveResult = {
  outcome: SolveOutcome;
  iters: number;
  residualInfNorm: number;
};

export type SolveResult = {
  /** Worst component outcome (singular > didnt-converge > solved). */
  outcome: SolveOutcome;
  /** Total iterations across components. */
  iters: number;
  /** Max component residual ∞-norm (drag rows excluded). */
  residualInfNorm: number;
  components: ComponentSolveResult[];
  /**
   * Entities that collapsed to ~zero size in the unpinned solve —
   * present only when the degenerate-collapse guard re-solved with
   * internal size pins (solve.ts); outcome/params are the pinned
   * re-solve's.
   */
  collapsed?: number[];
};

export type DragPoint = { ref: SolverRef; x: number; y: number };

export type DragSpec = {
  points: DragPoint[];
  /** Soft-row weight; hard constraints dominate. Default 0.1 (the
   * assembly CLOSURE_DRAG_WEIGHT discipline). */
  weight?: number;
  /**
   * Glue points that coincide by value but carry no constraint, so
   * chains drawn without explicit coincidents drag as one cluster
   * (today's chained feel). Default true. Rebuild solves never glue —
   * moving a literal apart on purpose must win there.
   */
  glue?: boolean;
};

export type SolveOptions = {
  maxIters?: number;
  /** Step-size stop ‖Δx‖ < tol. Default 1e-9. */
  tol?: number;
  /** Residual success threshold. Default 1e-8. */
  residualTol?: number;
  drag?: DragSpec;
};

export type DiagnoseOptions = {
  /** |residual| above this at convergence reads as conflicting.
   * Default 1e-6. */
  conflictTol?: number;
};

export type ComponentDiagnostics = {
  paramCount: number;
  dof: number;
};

export type SketchDiagnostics = {
  /** Σ over components of n_free − rank(J) at the current params. */
  dof: number;
  /** Ids of constraints with a residual above conflictTol. Internal
   * (negative) ids can appear — the statement layer maps them to the
   * owning entity. */
  conflicting: number[];
  /** Ids of satisfied constraints owning at least one row that does
   * not raise rank (greedy column-pivoted-QR attribution: which
   * member of an interdependent group is named is deterministic but
   * arbitrary). A constraint also conflicting is reported only as
   * conflicting. */
  redundant: number[];
  /**
   * ENTITY ids (unlike `conflicting`/`redundant`, which are constraint
   * ids) of non-fixed entities with at least one movable param — some
   * nullspace direction of the constraint Jacobian shifts them at the
   * current configuration. Sorted ascending; empty exactly when dof is
   * 0. Fixed entities (references, datums) are never listed — they
   * cannot move by construction.
   */
  underconstrainedEntities: number[];
  components: ComponentDiagnostics[];
};

/**
 * The serializable snapshot that rides the render payload (P2):
 * structure + solved params + verdicts.
 */
export type SketchSolverSystem = {
  entities: EntityRecord[];
  constraints: ConstraintRecord[];
  params: number[];
  outcome: SolveOutcome | null;
  dof: number | null;
  conflicting: number[];
  redundant: number[];
  /** Entity ids still free to move (diagnose's per-entity DOF read,
   * the UI's per-edge constrained tint); null when diagnostics didn't
   * run — unknown, never to be read as "all constrained". */
  underconstrainedEntities: number[] | null;
};
