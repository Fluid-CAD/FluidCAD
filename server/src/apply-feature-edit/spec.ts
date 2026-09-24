// The apply-feature-edit request and result contracts shared by every host and route.

import type { SketchConstraintEditSpec } from '../sketch-constraint-edit.ts';
import type { SketchSplitSpec } from '../sketch-split.ts';
import type { SketchTrimSpec } from '../sketch-trim.ts';
import type { SketchDeleteSpec } from '../sketch-entity-delete.ts';
import type { DistanceTangencySpec, SolvedEmissionSpec } from '../sketch-solved-edit/index.ts';
import type { ParamEditSpec } from '../param-edit.ts';
import type { MoveToPartSpec } from '../move-to-part.ts';
import type { RemoveFeatureSpec } from '../remove-feature.ts';
import type { InsertPartEditSpec } from '../part-catalog/insert-edit.ts';
import type { InstancePoseEditSpec } from '../insert-chain-edit.ts';
import type { AssemblyConnectorEditSpec } from '../assembly-connector-edit.ts';
import type { InsertParamsEditSpec } from '../insert-params-edit.ts';
import type {
  AssemblyExportEditSpec,
  AssemblyMateEditSpec,
  ConnectorPropsEditSpec,
} from '../assembly-mate-edit.ts';
import type { AssemblyReplicateEditSpec } from '../assembly-replicate-edit.ts';
import type { BooleanEditOptions, BooleanKind } from './features/boolean.ts';
import type { ChamferEditOptions } from './features/chamfer.ts';
import type { ConnectorAnchorSpec, ConnectorEditOptions, ConnectorRotateAxis } from './features/connector.ts';
import type { CopyEditOptions } from './features/copy.ts';
import type { ExposeEditOptions, ForeignExposureRef } from './features/expose.ts';
import type { ExtrudeEditOptions, ExtrudeTargetKind } from './features/extrude.ts';
import type { HelixEditOptions, HelixSourceSpec } from './features/helix.ts';
import type {
  EditLoftGuide,
  EditLoftProfile,
  LoftConditionSpec,
  LoftConnectionSpec,
  LoftEditOptions,
} from './features/loft.ts';
import type { MirrorAxisSpec, MirrorEditOptions } from './features/mirror.ts';
import type { OffsetEditOptions } from './features/offset.ts';
import type { PlaneEditBase, PlaneEditOptions, PlaneValueOptions } from './features/plane.ts';
import type { ProjectEditOptions } from './features/projection.ts';
import type {
  RepeatEditAxis,
  RepeatEditOptions,
  RepeatEditPlane,
  RepeatEditTargetSource,
} from './features/repeat.ts';
import type { RevolveAxisSpec, RevolveEditOptions } from './features/revolve.ts';
import type { RibEditOptions } from './features/rib.ts';
import type { RotateEditAxis, RotateEditOptions } from './features/rotate.ts';
import type { ShellEditOptions, ShellJoinKind } from './features/shell.ts';
import type { SweepEditOptions } from './features/sweep.ts';
import type { TextStatementOptions } from './features/text.ts';
import type { WrapEditOptions } from './features/wrap.ts';
import type { RegionName, RegionPickSpec, ValueExpr } from './value-expr.ts';

/**
 * Mirror of `lib/selection/types.ts` `ApplyFeatureEditSpec` — the wire
 * contract between the synthesis layer and this transform. Kept structural
 * here so the transform stays a dependency-free string function.
 */
export type ApplyFeatureEditSpec = {
  feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'text' | 'wrap' | 'repeat' | 'copy' | 'mirror' | 'rotate' | 'boolean' | 'helix' | 'project' | 'offset' | 'rib' | 'connector' | 'expose';
  /** Numeric parameter (radius/distance/thickness); absent for sketch. */
  value?: ValueExpr;
  /**
   * Pick-less sketch (empty `producers`/`parts`): the origin plane the
   * statement targets; absent renders the bare default-plane form.
   */
  sketchPlane?: 'xy' | 'xz' | 'yz';
  /**
   * Sketch on an existing `plane(…)` feature (empty `parts`): producers[0]
   * is the plane statement, bound to a variable that becomes the sketch's
   * first argument — `sketch(p, () => {})`.
   */
  sketchOnPlane?: boolean;
  /** Extrude-only payload; the profile is a sketch, not a pick selection. */
  extrude?: ExtrudeEditOptions;
  /** Rib-only payload; the spine is a sketch, the scope bound solid statements. */
  rib?: RibEditOptions;
  /** Sweep-only payload; `parts` (if any) render the path selector. */
  sweep?: SweepEditOptions;
  /** Wrap-only payload; the single `parts` entry renders the target face. */
  wrap?: WrapEditOptions;
  /** Project-only payload; names the sketch body the statement lands in. */
  project?: ProjectEditOptions;
  /** Shell-only payload; the join type chains after the selector args. */
  shell?: ShellEditOptions;
  /** Chamfer-only payload; the second value rides after the distance. */
  chamfer?: ChamferEditOptions;
  /** Offset-only payload; the boolean argument and the `.close()` chain. */
  offset?: OffsetEditOptions;
  /**
   * Connector-only payload: the name the statement registers, plus the call
   * site of the `part(...)` block whose callback body receives the statement
   * (end of body, before a trailing `return` or active `breakpoint();`).
   */
  connector?: ConnectorEditOptions;
  /**
   * Expose-only payload: the name the statement registers, plus the call
   * site of the `part(...)` block whose callback body receives the statement
   * — the connector insertion mechanism minus the frame adjustments.
   */
  expose?: ExposeEditOptions;
  /** Cross-part sketch payload: `sketch(<ident>.features.<name>, …)` into the active part. */
  sketchForeign?: ForeignExposureRef;
  /**
   * Text-on-path create payload: the dialog's option values, rendered around
   * the single `parts` entry (the path's bare variable). In-place edits ride
   * `edit.text` instead.
   */
  text?: TextStatementOptions;
  /** Loft-only payload; each `parts` entry renders one profile's selector. */
  loft?: LoftEditOptions;
  /** Plane-only payload; each `parts` entry renders one base's selector. */
  plane?: PlaneEditOptions;
  /** Revolve-only payload; `parts` (if any) render the axis-edge selector. */
  revolve?: RevolveEditOptions;
  /** Helix-only payload; `parts` (if any) render the source (axis-edge or face) selector. */
  helix?: HelixEditOptions;
  /** Repeat-only payload; `parts` (if any) render the axis/plane selector. */
  repeat?: RepeatEditOptions;
  /** Copy-only payload; `parts` (if any) render the axis selector. */
  copy?: CopyEditOptions;
  /** Mirror-only payload; `parts` (if any) render the plane selector. */
  mirror?: MirrorEditOptions;
  /** Rotate-only payload; `parts` (if any) render the axis-edge selector. */
  rotate?: RotateEditOptions;
  /** Boolean-only payload (fuse/subtract/common); no selector parts. */
  boolean?: BooleanEditOptions;
  filePath: string;
  producers: {
    line: number;
    column: number;
    featureType: string;
    nameHint: string;
    /**
     * True when the call must be bound to a variable. False marks an
     * anchor-only entry whose statement just locates the insertion scope
     * (used when every part is a global `select()` expression).
     */
    bind: boolean;
  }[];
  parts: {
    /** Index into `producers`, or null for a global `select()` part. */
    producer: number | null;
    accessor: string;
    indices: number[] | null;
    /** Rendered filter-builder arguments, e.g. `edge().circle(5)`. */
    filterArgs: string | null;
    /**
     * Producers (indices into `producers`) that `filterArgs` references
     * through `{{r<n>}}` tokens — plane-reference selectors like
     * `face().onPlane({{r0}}.endFaces())`. Rendering substitutes each token
     * with the bound variable's name.
     */
    refs?: number[] | null;
  }[];
  /** Extra symbols the statement references (`select`, `edge`, `face`). */
  imports: string[];
  /**
   * User-edited replacement for the whole selector argument list. Emitted
   * verbatim instead of rendering `parts`; extra imports are derived from
   * its text.
   */
  rawArgs?: string;
  /**
   * In-place statement edit (timeline double-click → edit dialog): rewrite
   * the existing feature statement at this location instead of inserting a
   * new one. `producers`/`parts` participate only when the edit re-sources
   * an argument slot (a re-picked profile/path/selection): referenced
   * producers bind exactly like create mode — their statements must precede
   * the edited one in the same scope — and `parts` render the re-picked
   * selector expressions. Slots without a source field keep their statement
   * text verbatim.
   */
  edit?: FeatureStatementEditTarget;
  /**
   * Solved-sketch constraint emission (sketch-rewrite P4): hoist unbound
   * entity statements and append a constraint statement at the sketch body's
   * end, in one edit. Rides the generic apply-feature-edit round trip; every
   * other spec field is ignored.
   */
  sketchConstraint?: SketchConstraintEditSpec;
  /**
   * Solved-sketch drawing-tool emission (sketch-rewrite P5): insert geometry
   * statements (before the body's first constraint statement) and constraint
   * statements (appended at the body end) in one edit, hoisting/binding as
   * needed. Rides the same round trip as `sketchConstraint`; every other
   * spec field is ignored.
   */
  sketchEmission?: SolvedEmissionSpec;
  /**
   * Distance-dimension tangency rewrite (timeline "Use min/max tangent"):
   * strip any chained `.max()`/`.min()` on the statement and append `.max()`
   * when the far side is requested. Rides the same round trip as
   * `sketchConstraint`; every other spec field is ignored.
   */
  distanceTangency?: DistanceTangencySpec;
  /**
   * Sketch Split tool (2D): rewrite an entity statement as the first piece
   * the kernel cut, bind the second piece right after it, re-home the
   * constraints that referenced the entity and append the junction
   * coincident(s). Rides the same round trip as `sketchEmission`; every
   * other spec field is ignored.
   */
  sketchSplit?: SketchSplitSpec;
  /**
   * Sketch Trim tool (2D): delete one piece of an entity statement the
   * kernel cut at its nearest intersections — rewrite the statement as what
   * survives, re-home or drop the references to what went. Rides the same
   * round trip as `sketchSplit`; every other spec field is ignored.
   */
  sketchTrim?: SketchTrimSpec;
  /**
   * Sketcher Delete key (2D): remove the picked entity statements from the
   * sketch body in one edit, with the constraints naming them and the
   * statements that consumed them; geometry that borrowed one of their
   * points keeps its place. Rides the same round trip as `sketchTrim`;
   * every other spec field is ignored.
   */
  sketchDelete?: SketchDeleteSpec;
  /**
   * Parameters-panel declaration edit: add, retype/rename, or delete a
   * `param()` call. Rides the same round trip for the same reason a segment
   * swap does — the transform is pure and the host stays generic; every other
   * spec field is ignored.
   */
  paramEdit?: ParamEditSpec;
  /**
   * Insert-dialog instance insertion: import a catalog part's export and
   * append `const <name> = insert(...)` at the end of the assembly file.
   * Rides the same round trip as `paramEdit`; every other spec field is
   * ignored.
   */
  insertPart?: InsertPartEditSpec;
  /**
   * Assembly-gizmo pose commit: rewrite an `insert()` chain's
   * `.translate()`/`.rotate()` calls to reproduce the instance's final world
   * pose. Rides the same round trip as `insertPart`; every other spec field
   * is ignored.
   */
  instancePose?: InstancePoseEditSpec;
  /**
   * Edit-parameters commit: merge changed parameter values into an
   * `insert()` statement's second argument (untouched entries survive
   * verbatim, expressions included). Rides the same round trip as
   * `instancePose`; every other spec field is ignored.
   */
  insertParams?: InsertParamsEditSpec;
  /**
   * Mate-dialog statement write: append or re-render a
   * `mate(type, a.connectors.x, b.connectors.y)<chain>` statement in the
   * assembly file. Rides the same round trip as `instancePose`; every other
   * spec field is ignored.
   */
  assemblyMate?: AssemblyMateEditSpec;
  /**
   * Assembly-connector dialog write: append a `const <name> = connector('<name>',
   * [x, y, z])<rotates>` statement at the assembly's top level, or rewrite
   * the one at its source line. Rides the same round trip as
   * `instancePose` (expression extras land through `newVariables`); every
   * other spec field is ignored.
   */
  assemblyConnector?: AssemblyConnectorEditSpec;
  /**
   * Mate-dialog pen-button edit: rewrite a `connector()` statement's name
   * and adjustment chain in its part file (the spec's `filePath` addresses
   * that file, so the current-file preflight self-skips). Rides the same
   * round trip as `assemblyMate`; every other spec field is ignored.
   */
  connectorProps?: ConnectorPropsEditSpec;
  /**
   * Occurrence-aware mate prerequisite: ensure the handle inserted on
   * `insertLine` is exported from its `assembly()` body's return object, so
   * the inserting file can reference it as `<occBinding>.parts.<key>`. The
   * spec's `filePath` addresses the SUB-ASSEMBLY file (current-file
   * preflight self-skips, like `connectorProps`). Rides the same round trip
   * as `assemblyMate`; every other spec field is ignored.
   */
  assemblyExport?: AssemblyExportEditSpec;
  /**
   * Replicate-dialog statement write: append a `replicate(seed, [targets],
   * [rows])` statement after the seed's last mate, re-render the one at its
   * source line, or drop one of its rows. Rides the same round trip as
   * `assemblyMate`; every other spec field is ignored.
   */
  assemblyReplicate?: AssemblyReplicateEditSpec;
  /**
   * Part-tool statement write: append `part('<name>', () => {})` at top
   * level, the name auto-allocated past every part name already in the file
   * when absent. Rides the same round trip as `insertPart`; every other
   * spec field is ignored.
   */
  newPart?: { name?: string };
  /**
   * Timeline drag-drop: move the selected top-level feature statements into
   * a `part(...)` callback body, dependency-checked against the whole file.
   * Rides the same round trip as `newPart`; every other spec field is
   * ignored.
   */
  moveToPart?: MoveToPartSpec;
  /**
   * Timeline "Remove" with cascade: delete the feature statement and every
   * statement that references what it bound, recursively. Rides the same
   * round trip as `moveToPart`; every other spec field is ignored.
   */
  removeFeature?: RemoveFeatureSpec;
  /**
   * Add or remove the `.close()` chain on the sketch statement at
   * `sourceLine` — the Finish Sketch button and the reopen-for-edit gesture.
   * Rides the acked round trip so the caller can sequence its breakpoint
   * edit after it; every other spec field is ignored.
   */
  sketchClosed?: SketchClosedEditSpec;
  /**
   * The `part(...)` call site whose callback body receives the created
   * statement — the timeline's active part. Only the producer-less appends
   * honor it (pick-less sketch, standard-only plane, standard-axis helix):
   * a producer-carrying create already lands in its producers' scope, which
   * is the part body exactly when the picked inputs live inside it.
   */
  activePart?: { line: number; column: number };
  /**
   * Strip every `breakpoint();` after the rewrite. Set when an edit dialog
   * applies: the double-click that opened it placed a breakpoint, and
   * applying clears it so the model rebuilds to its tip. Done inside this
   * one transform so the rewrite and the clear never race on the buffer.
   */
  clearBreakpoints?: boolean;
  /**
   * `const <name> = <initializer>;` declarations to write directly before
   * the statement — a dialog expression field's `myVar = 50` (or a fresh
   * name typed over a numeric seed). Names already declared in the file are
   * skipped, keeping a re-apply idempotent.
   */
  newVariables?: { name: string; initializer: string }[];
};

/**
 * A re-sourced sketch slot of an edited statement: keep the statement's own
 * argument text, or reference a `producers` entry to bind. Absent fields
 * read as `keep`, so value-only edits stay byte-identical on those slots.
 */
export type EditSketchSource = { kind: 'keep' } | { kind: 'sketch'; producer: number };

/** A re-sourced sweep path: keep, a bound sketch, or the selector from `parts`. */
export type EditPathSource = EditSketchSource | { kind: 'selector' };

/**
 * Dialog edits to apply over the feature statement at `line`. Only the
 * options the dialogs expose ride here — argument expressions they don't
 * edit (profiles, paths, selector args) are re-read from the statement at
 * apply time and preserved verbatim. Fillet/chamfer/shell reuse the spec's
 * top-level `value` (and `rawArgs` when the selector text was edited, or
 * `parts` when the selection was re-picked).
 */
export type FeatureStatementEditTarget = {
  line: number;
  column: number;
  /**
   * Staleness guard: the exact chain text `/api/feature/parse` returned when
   * the dialog opened. The rewrite refuses when the statement no longer
   * reads identically — the file changed under the session, and positional
   * slots (loft `verbatim` indices, the value being replaced) could land on
   * the wrong expressions.
   */
  expectedStatement?: string;
  extrude?: {
    op: 'add' | 'remove' | 'new';
    distance: ValueExpr | null;
    distance2: ValueExpr | null;
    symmetric: boolean;
    draft: ValueExpr | null;
    /** `.endOffset(value)` pull-back, or null for no chain. */
    endOffset: ValueExpr | null;
    drill: boolean;
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
    /**
     * Up-to-face target: `keep` re-emits the statement's own target text,
     * `selector` renders the re-picked face from `parts`, `first-face` /
     * `last-face` render that literal. Absent writes the distance form
     * (dropping any target the statement had).
     */
    toFace?: { kind: 'keep' | ExtrudeTargetKind };
    /**
     * Full replacement `.scope(…)` list — `verbatim` keeps by position in the
     * statement's own argument texts, re-picked solid statements by bound
     * producer. Absent keeps the statement's scope chain; an empty list drops
     * it (back to whole-scene fusion).
     */
    scope?: RepeatEditTargetSource[];
    /** Full replacement `.region(…)` list; absent keeps, `[]` drops the chain. */
    regions?: RegionName[];
    /**
     * The dialog's region picks, replacing the chain outright: the transform
     * declares new boundaries in the profile sketch, reuses the declarations
     * that already list a pick, drops the declarations the statement alone
     * referenced, and writes the names into `regions`. Absent keeps the
     * chain; `[]` drops it.
     */
    regionPicks?: RegionPickSpec[];
    /**
     * The profile sketch the picks belong to when the statement keeps its
     * profile (`profile` absent) — the dialog knows it from the scene. With a
     * re-sourced profile the producer is the sketch.
     */
    regionSketch?: { line: number; column: number };
  };
  rib?: {
    op: 'add' | 'remove' | 'new';
    thickness: ValueExpr;
    parallel: boolean;
    extend: boolean;
    draft: ValueExpr | null;
    /** Re-sourced spine; absent keeps the statement's spine text. */
    spine?: EditSketchSource;
    /**
     * Full replacement `.scope(…)` list — `verbatim` keeps by position in the
     * statement's own argument texts, re-picked solid statements by bound
     * producer. Absent keeps the statement's scope chain; an empty list drops
     * it (back to whole-scene fusion).
     */
    scope?: RepeatEditTargetSource[];
  };
  sweep?: {
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** `.extend('start', …)` lead-in before the path; null or absent writes none. */
    extendStart?: ValueExpr | null;
    /** `.extend('end', …)` run-out past the path; null or absent writes none. */
    extendEnd?: ValueExpr | null;
    /** Re-sourced path; absent keeps the statement's path text. */
    path?: EditPathSource;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
    /** Full replacement `.scope(…)` list; absent keeps, `[]` drops the chain. */
    scope?: RepeatEditTargetSource[];
    /** Full replacement `.region(…)` list; absent keeps, `[]` drops the chain. */
    regions?: RegionName[];
    /**
     * The dialog's region picks, replacing the chain outright: the transform
     * declares new boundaries in the profile sketch, reuses the declarations
     * that already list a pick, drops the declarations the statement alone
     * referenced, and writes the names into `regions`. Absent keeps the
     * chain; `[]` drops it.
     */
    regionPicks?: RegionPickSpec[];
    /**
     * The profile sketch the picks belong to when the statement keeps its
     * profile (`profile` absent) — the dialog knows it from the scene. With a
     * re-sourced profile the producer is the sketch.
     */
    regionSketch?: { line: number; column: number };
  };
  wrap?: {
    op: 'add' | 'remove' | 'new';
    thickness: ValueExpr;
    /** Re-sourced sketch; absent keeps the statement's sketch text. */
    sketch?: EditSketchSource;
    /**
     * Re-picked target face rendered from the single `parts` entry; absent
     * keeps the statement's own face text.
     */
    face?: { kind: 'selector' };
    /** Full replacement `.region(…)` list; absent keeps, `[]` drops the chain. */
    regions?: RegionName[];
    /**
     * The dialog's region picks, replacing the chain outright: the transform
     * declares new boundaries in the profile sketch, reuses the declarations
     * that already list a pick, drops the declarations the statement alone
     * referenced, and writes the names into `regions`. Absent keeps the
     * chain; `[]` drops it.
     */
    regionPicks?: RegionPickSpec[];
    /**
     * The profile sketch the picks belong to when the statement keeps its
     * profile (`profile` absent) — the dialog knows it from the scene. With a
     * re-sourced profile the producer is the sketch.
     */
    regionSketch?: { line: number; column: number };
  };
  shell?: {
    joinType: ShellJoinKind;
  };
  /**
   * Chamfer second-value slot; absent keeps the statement's own second
   * value, `distance2: null` returns it to the equal-distance form.
   */
  chamfer?: ChamferEditOptions;
  /**
   * Connector options — always explicit on an edit: a cleared rotation or
   * offset field writes `null` and drops that chain rather than keeping the
   * statement's own. The source expression is NOT here: it follows the
   * selector-args contract (the edited expression row, a re-picked selection,
   * else the statement's own text), anchor suffix included.
   */
  connector?: {
    name: string;
    rotate: { axis: ConnectorRotateAxis; angle: number } | null;
    offset: [number, number, number] | null;
    /**
     * The anchor a RE-PICKED source narrows to, rendered as the suffix on the
     * selector parts (the create path's contract — the parts carry the plain
     * accessor). Ignored when the args come from the edited expression row or
     * the statement's own text: both already spell the anchor out.
     */
    anchor?: ConnectorAnchorSpec;
  };
  loft?: {
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    startCondition?: LoftConditionSpec;
    endCondition?: LoftConditionSpec;
    /** Full replacement profile list; absent keeps all statement profiles. */
    profiles?: EditLoftProfile[];
    /**
     * Full replacement guide list; absent keeps the statement's guides,
     * `[]` removes them all.
     */
    guides?: EditLoftGuide[];
    /** Full replacement connections; omitted keeps, [] removes all. */
    connections?: LoftConnectionSpec[];
    /** Full replacement `.scope(…)` list; absent keeps, `[]` drops the chain. */
    scope?: RepeatEditTargetSource[];
  };
  revolve?: {
    op: 'add' | 'remove' | 'new';
    /** Sweep angle in degrees; 360 renders no angle argument. */
    angle: ValueExpr;
    /** `.symmetric()` — the sweep splits equally across the sketch plane. */
    symmetric: boolean;
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
    /** Re-sourced axis; absent keeps the statement's axis text. */
    axis?: RevolveAxisSpec;
    /** Full replacement `.scope(…)` list; absent keeps, `[]` drops the chain. */
    scope?: RepeatEditTargetSource[];
    /** Full replacement `.region(…)` list; absent keeps, `[]` drops the chain. */
    regions?: RegionName[];
    /**
     * The dialog's region picks, replacing the chain outright: the transform
     * declares new boundaries in the profile sketch, reuses the declarations
     * that already list a pick, drops the declarations the statement alone
     * referenced, and writes the names into `regions`. Absent keeps the
     * chain; `[]` drops it.
     */
    regionPicks?: RegionPickSpec[];
    /**
     * The profile sketch the picks belong to when the statement keeps its
     * profile (`profile` absent) — the dialog knows it from the scene. With a
     * re-sourced profile the producer is the sketch.
     */
    regionSketch?: { line: number; column: number };
  };
  /**
   * Helix options. The chained geometry configurators edit in place; the
   * source re-sources when set, else the statement's own source text is kept
   * verbatim (an axis literal/statement or a face selector).
   */
  helix?: {
    radius: ValueExpr | null;
    endRadius: ValueExpr | null;
    pitch: ValueExpr | null;
    turns: ValueExpr | null;
    height: ValueExpr | null;
    startOffset: ValueExpr | null;
    endOffset: ValueExpr | null;
    /** Re-sourced source; absent keeps the statement's own source text. */
    source?: HelixSourceSpec;
  };
  /**
   * Sketch retarget (the sketch dialog's re-pick): rewrite the statement's
   * target argument — an origin-plane literal, a bound `plane(…)` producer,
   * or the face selector rendered from the single `parts` entry — while the
   * body callback is re-read at apply time and preserved verbatim.
   */
  sketch?: {
    target:
      | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
      | { kind: 'plane'; producer: number }
      | { kind: 'selector' };
  };
  /**
   * Repeat options. Axis/plane slots and the target list carry keep
   * (`keep`/`verbatim`) entries that re-read the statement's own argument
   * texts at apply time; re-sourced entries render from producers/parts like
   * create mode. An absent target list keeps every statement target (an
   * implicit last-feature repeat stays implicit).
   */
  repeat?: {
    kind: 'linear' | 'circular' | 'mirror' | 'rotate';
    /** Linear directions in axis order — each its own axis, count and value. */
    directions?: { axis: RepeatEditAxis; count: ValueExpr; value: ValueExpr }[];
    /** Linear spacing semantics shared by every direction. */
    spacingMode?: 'offset' | 'length';
    /** Linear only: center the pattern on the original instance. */
    centered?: boolean;
    /** The repeat axis (circular/rotate); linear carries axes per direction. */
    axis?: RepeatEditAxis;
    /** The mirror plane (mirror only). */
    plane?: RepeatEditPlane;
    /** Instance count, original included (circular). */
    count?: ValueExpr;
    /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
    sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
    /** Rotate only: rotation angle in degrees; 90 renders no argument. */
    angle?: ValueExpr;
    /** Full replacement target list; absent keeps the statement's targets. */
    targets?: RepeatEditTargetSource[];
  };
  /**
   * Copy options. Axis slots and the target list carry keep
   * (`keep`/`verbatim`) entries that re-read the statement's own argument
   * texts at apply time; re-sourced entries render from producers/parts like
   * create mode. An absent target list keeps every statement target.
   */
  copy?: {
    kind: 'linear' | 'circular';
    /** Linear directions in axis order — each its own axis, count and value. */
    directions?: { axis: RepeatEditAxis; count: ValueExpr; value: ValueExpr }[];
    /** Linear spacing semantics shared by every direction. */
    spacingMode?: 'offset' | 'length';
    /** Linear only: center the pattern on the original instance. */
    centered?: boolean;
    /** The copy axis (circular); linear carries axes per direction. */
    axis?: RepeatEditAxis;
    /**
     * The 2D circular form's center point (inside a sketch) — replaces the
     * axis argument outright; the dialog always sends its field values.
     */
    center?: [ValueExpr, ValueExpr];
    /** Instance count, original included (circular). */
    count?: ValueExpr;
    /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
    sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
    /**
     * Instances to leave out, one index per direction. The dialog owns the
     * option outright — an absent list drops the statement's own, exactly as
     * an unticked `centered` does.
     */
    skip?: number[][];
    /** Full replacement target list; absent keeps the statement's targets. */
    targets?: RepeatEditTargetSource[];
  };
  /**
   * Mirror options. The plane slot carries a keep entry that re-reads the
   * statement's own plane text at apply time; a re-sourced plane renders
   * from producers/parts like create mode. The target list mixes `verbatim`
   * keeps with re-picked feature statements; an absent list keeps every
   * statement target. The op rewrites the trailing chain wholesale. The 2D
   * in-sketch form carries an `axis` slot where the plane was (mutually
   * exclusive): its keep entry re-reads the statement's first argument —
   * the axis text — and its op is always `add`.
   */
  mirror?: {
    /** The mirror plane; `keep` re-emits the statement's own expression. */
    plane?: RepeatEditPlane;
    /** The 2D mirror line; `keep` re-emits the statement's own expression. */
    axis?: { kind: 'keep' } | MirrorAxisSpec;
    /** How the reflected bodies land: fused (the default), cut, or standalone. */
    op: 'add' | 'remove' | 'new';
    /** Full replacement target list; absent keeps the statement's targets. */
    targets?: RepeatEditTargetSource[];
  };
  /**
   * Rotate options. The axis slot carries a keep entry that re-reads the
   * statement's own axis text at apply time; a re-sourced axis renders from
   * producers/parts like create mode. The angle and the copy flag rewrite
   * wholesale (the dialog owns them); the target list mixes `verbatim` keeps
   * with re-picked feature statements; an absent list keeps every statement
   * target.
   */
  rotate?: {
    /** The rotation axis; `keep` re-emits the statement's own expression. */
    axis: RotateEditAxis;
    /** The rotation angle in degrees. */
    angle: ValueExpr;
    /** Keep the originals in place — the `true` third argument. */
    copy: boolean;
    /** Full replacement target list; absent keeps the statement's targets. */
    targets?: RepeatEditTargetSource[];
  };
  /**
   * Boolean options (fuse/subtract/common). The kind picks the callee — an
   * edit may rewrite a fuse into a subtract. The target list mixes
   * `verbatim` keeps (re-read from the statement's own argument texts) with
   * re-picked feature statements; an absent list keeps every statement
   * target.
   */
  boolean?: {
    kind: BooleanKind;
    /** Full replacement target list; absent keeps the statement's targets. */
    targets?: RepeatEditTargetSource[];
  };
  /**
   * Plane options. The type and the numeric options rewrite wholesale (the
   * dialog owns every one of them); the base list mixes `verbatim` keeps
   * (re-read from the statement's own argument texts) with re-picked bases,
   * and an absent list keeps every base the statement has.
   */
  plane?: PlaneValueOptions & {
    /** Full replacement base list; absent keeps the statement's bases. */
    bases?: PlaneEditBase[];
  };
  /**
   * Text options. Without `path`, the statement's path argument (when
   * present) is re-read at apply time and preserved verbatim; defaults
   * render no chain (size 10, weight 400, upright, left, spacing 1/0).
   */
  text?: TextStatementOptions & {
    /**
     * The path argument: absent keeps the statement's own path text
     * verbatim, `none` drops it (back to plain anchored text), `selector`
     * renders the re-picked path geometry from the single `parts` entry (a
     * bare variable, bound like create mode).
     */
    path?: { kind: 'none' } | { kind: 'selector' };
  };
};

/** The Finish Sketch chain edit: see {@link setSketchClosed}. */
export type SketchClosedEditSpec = {
  /** The sketch statement's 1-based source line. */
  sourceLine: number;
  closed: boolean;
};

export type ApplyFeatureEditResult = {
  newCode: string;
  error?: string;
};

export function validEditOp(op: unknown): op is 'add' | 'remove' | 'new' {
  return op === 'add' || op === 'remove' || op === 'new';
}

/** The spec fields `renderEditedStatement` reads. */
export type EditRenderSpec = Pick<ApplyFeatureEditSpec, 'feature' | 'value' | 'offset' | 'rawArgs' | 'edit' | 'producers' | 'parts'>;

/**
 * The top-level transform, handed to the paths that apply nested `expose`
 * creates (cross-part references, tangent mates) so they recurse through
 * the same dispatch without importing it.
 */
export type FeatureEditApply = (code: string, spec: ApplyFeatureEditSpec) => Promise<ApplyFeatureEditResult>;
