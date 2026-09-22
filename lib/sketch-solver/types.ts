// Public data model of the 2D sketch constraint solver.
//
// lib/sketch-solver/ is pure TS: it may import only its own modules
// and lib/solver-core/ (enforced by
// lib/tests/sketch-solver/purity.test.ts), so the same engine runs in
// the kernel (Node, P2) and the browser (P4 drag loop). Everything in
// this file is JSON-serializable — it is the shape that rides the
// render payload to the UI.

export type EntityKind = 'point' | 'line' | 'circle' | 'arc' | 'ellipse';

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
 * center/start/end, ellipse center.
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
  /** Point–point (2) or point-on-line / point-on-circle-or-arc /
   * point-on-ellipse (1), chosen by what the refs resolve to.
   * Point-on-line means the infinite line; point-on-circle means the
   * full circle. */
  | { kind: 'coincident'; a: SolverRef; b: SolverRef }
  /** One line (1), one ellipse (1 — its RX axis runs along the sketch
   * x / y direction), or two or more points sharing the axis value
   * (1 per pair — `others` extends the POINT form only; every point
   * after the first is aligned to the first). */
  | { kind: 'horizontal'; a: SolverRef; b?: SolverRef; others?: SolverRef[] }
  | { kind: 'vertical'; a: SolverRef; b?: SolverRef; others?: SolverRef[] }
  /** Line–line (1). */
  | { kind: 'parallel'; a: SolverRef; b: SolverRef; others?: SolverRef[] }
  /** Line–line (1). */
  | { kind: 'perpendicular'; a: SolverRef; b: SolverRef }
  /** Counterclockwise angle from line a's oriented direction to line
   * b's, radians, [0, 2π) (1). A bare line ref (or its 'end' point)
   * orients start→end; a 'start' point ref reverses it — the four
   * sectors at the lines' intersection are all expressible with a
   * positive value. */
  | { kind: 'angle'; a: SolverRef; b: SolverRef; value: number }
  /**
   * Line–circle/arc (1), circle–circle (1), line–ellipse (1), or
   * ellipse–circle/arc/ellipse (1 net: the contact point rides along as
   * two compile-time aux params under three rows); branch from guesses.
   */
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
  /** Circle/arc radius (1), or one semi-radius of an ellipse — `axis`
   * names which ('x' = RX, 'y' = RY) and is required there, refused on a
   * circle/arc. */
  | { kind: 'radius'; a: SolverRef; value: number; axis?: 'x' | 'y' }
  | { kind: 'diameter'; a: SolverRef; value: number }
  /** Equal line lengths, equal radii (1 per pair) or equal ellipse shapes
   * (2 per pair: both semi-radii). `others` extends the equality to
   * further entities of the same family — each is equated to `a`. */
  | { kind: 'equal'; a: SolverRef; b: SolverRef; others?: SolverRef[] }
  /** Circle/arc/ellipse centers coincide (2). */
  | { kind: 'concentric'; a: SolverRef; b: SolverRef }
  /** Both endpoints of line b on the infinite line of a (2). */
  | { kind: 'collinear'; a: SolverRef; b: SolverRef }
  /** Point p is the midpoint of line l (2). */
  | { kind: 'midpoint'; p: SolverRef; l: SolverRef }
  /** Point p sits halfway between points a and b (2). Same rows as the
   * line form with a/b standing in for the line's endpoints. */
  | { kind: 'midpoint'; p: SolverRef; a: SolverRef; b: SolverRef }
  /** Points a and b mirror across line l (2); or two entities of one kind
   * — lines (4), circles (3), arcs (5), ellipses (5). */
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
  | { kind: 'arc-consistency'; entity: number }
  /**
   * Internal affine tie for derived entities (2D copy instances):
   * `target` is rigidly derived from `source` (same kind) through
   * p' = [[a,b],[c,d]]·p + [tx,ty] with matrix = [a, b, c, d, tx, ty].
   * One LINEAR row per free target param (point 2, line 4, circle 3,
   * arc 7, ellipse 5 — center and radii linear, the rotation through
   * one angular row), so a tied entity adds zero net DOF and
   * constraining either side moves both. Added via SketchSystem.addTransformTie —
   * never user-authored; carries a negative id, and diagnose never
   * names it in conflicting/redundant (conflicts surface on the user
   * constraints in the same component).
   */
  | {
      kind: 'transform-tie';
      source: number;
      target: number;
      matrix: [number, number, number, number, number, number];
    }
  /**
   * Internal reflection tie for derived entities (2D mirror images):
   * `target` is the mirror image of `source` (same kind) across `axis`
   * — a solver LINE entity (a sketched mirror line or a datum axis; the
   * rows then carry the line's params, so a moving mirror line moves
   * its images) or a constant line [sx, sy, ex, ey] in sketch
   * coordinates (a world axis). One row per target param (point 2,
   * line 4, circle 3, arc 7, ellipse 5): net-zero DOF, bidirectional
   * coupling.
   * Added via SketchSystem.addMirrorTie — never user-authored; negative
   * id, and diagnose never names it (like transform-tie).
   */
  | {
      kind: 'mirror-tie';
      source: number;
      target: number;
      axis: SolverRef | [number, number, number, number];
    };

export type ConstraintKind = ConstraintSpec['kind'];

/** A constraint as stored/serialized: spec plus identity. Internal
 * records (arc-consistency, transform-tie, mirror-tie) carry negative
 * auto-assigned ids; user ids are ≥ 0. */
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
   * arc [cx,cy,r,sx,sy,ex,ey]; ellipse [cx,cy,rx,ry,theta] — semi-radii
   * along the ellipse's own axes plus the rotation of its RX axis from
   * the sketch x direction (radians). */
  paramOffset: number;
};

/**
 * A compile-time scratch param owned by a constraint's rows (the
 * contact point of an ellipse tangency): allocated after the entity
 * params when the rows compile, keyed by (constraint id, slot) so a
 * recompile carries the last value over — a warm re-solve never
 * restarts the contact search from the geometric guess.
 */
export type AuxParamRecord = { constraint: number; slot: number; value: number };

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
  /** Step-size stop ‖Δx‖ < tol. Default 1e-9 mm / lengthScale. */
  tol?: number;
  /** Residual success threshold. Default 1e-8 mm / lengthScale. */
  residualTol?: number;
  /**
   * Millimetres per sketch length unit (25.4 for an inch document). The
   * absolute floors (glue, collapse guard, default tolerances) are
   * authored in mm and divided by it, so a sketch keeps the same physical
   * behaviour in every unit. Default 1. The solver stays unit-agnostic:
   * the caller that knows the document's unit passes it.
   */
  lengthScale?: number;
  drag?: DragSpec;
};

export type DiagnoseOptions = {
  /** |residual| above this at convergence reads as conflicting.
   * Default 1e-6 mm / lengthScale. */
  conflictTol?: number;
  /** Millimetres per sketch length unit; see SolveOptions.lengthScale. */
  lengthScale?: number;
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
   * owning entity — except transform-tie/mirror-tie records, which are
   * never named here (nor in `redundant`): a conflicted tie's residual is
   * least-squares spread, and the user rows in the same component
   * carry the verdict. */
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
  /** Entity params only (aux slots ride separately in `aux`). */
  params: number[];
  /** Constraint-owned aux params at the snapshot — a rebuild from the
   * snapshot seeds them (SketchSystem.seedAux) so its first solve starts
   * where the kernel's ended. Absent when nothing allocated any. */
  aux?: AuxParamRecord[];
  outcome: SolveOutcome | null;
  dof: number | null;
  conflicting: number[];
  redundant: number[];
  /** Entity ids still free to move (diagnose's per-entity DOF read,
   * the UI's per-edge constrained tint); null when diagnostics didn't
   * run — unknown, never to be read as "all constrained". */
  underconstrainedEntities: number[] | null;
};
