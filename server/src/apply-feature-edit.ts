import {
  getJavaScriptParser,
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  indentOf,
  isBreakpointStatement,
  splitLines,
  spliceCode,
  walkTree,
  clearBreakpoints as stripBreakpoints,
  type TSNode,
  type TSTree,
} from './code-editor.ts';

/**
 * A dialog numeric slot: a plain number, or verbatim expression text
 * (`height`, `h * 2`) committed by a dialog's expression field. Expressions
 * render as-is into the statement; the build surfaces evaluation errors.
 */
export type ValueExpr = number | string;

/**
 * Whether `text` is safe to embed as a single call argument: one line, no
 * statement separators or comments, balanced brackets, and no top-level
 * comma or assignment that would change the argument list's shape.
 */
export function isExpressionText(text: unknown): text is string {
  if (typeof text !== 'string') {
    return false;
  }
  const t = text.trim();
  if (!t || t.length > 200 || /[;\r\n`]/.test(t) || t.includes('//') || t.includes('/*')) {
    return false;
  }
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if ((ch === ')' && open !== '(') || (ch === ']' && open !== '[') || (ch === '}' && open !== '{')) {
        return false;
      }
    } else if (stack.length === 0) {
      if (ch === ',') {
        return false;
      }
      // A top-level assignment would leak a statement into the argument;
      // comparison (`==`, `<=`, `>=`, `!=`) and arrows are fine.
      if (ch === '=' && t[i + 1] !== '=' && t[i + 1] !== '>' && !/[=!<>]/.test(t[i - 1] ?? '')) {
        return false;
      }
    }
  }
  return quote === null && stack.length === 0;
}

/** A repeat count slot: an integer of at least 2, or safe expression text. */
export function validCountValue(value: unknown): value is ValueExpr {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 2;
  }
  return isExpressionText(value);
}

/**
 * Validate one ValueExpr slot: a finite number meeting the constraints, or
 * safe expression text (constraints can't be checked statically there — the
 * build reports them).
 */
export function validValueExpr(
  value: unknown,
  opts: { nonzero?: boolean; positive?: boolean } = {},
): value is ValueExpr {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return false;
    }
    if (opts.nonzero && value === 0) {
      return false;
    }
    if (opts.positive && value <= 0) {
      return false;
    }
    return true;
  }
  return isExpressionText(value);
}

/**
 * Mirror of `lib/selection/types.ts` `ApplyFeatureEditSpec` — the wire
 * contract between the synthesis layer and this transform. Kept structural
 * here so the transform stays a dependency-free string function.
 */
export type ApplyFeatureEditSpec = {
  feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'text' | 'wrap' | 'repeat' | 'copy' | 'boolean' | 'helix' | 'project' | 'offset' | 'trim' | 'fuse' | 'subtract' | 'common';
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
 * One profile of an edited loft, in argument order: an untouched profile by
 * its position in the statement's own argument list (`verbatim` — re-read at
 * apply time, never stale text from dialog-open), a re-picked sketch, or a
 * re-picked face rendered from `parts`.
 */
export type EditLoftProfile =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'sketch'; producer: number }
  | { kind: 'selector'; part: number };

/** One guide of an edited loft — like profiles, but never a selector. */
export type EditLoftGuide =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'sketch'; producer: number };

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
  };
  sweep?: {
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** Re-sourced path; absent keeps the statement's path text. */
    path?: EditPathSource;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
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
  };
  shell?: {
    joinType: ShellJoinKind;
  };
  /**
   * Chamfer second-value slot; absent keeps the statement's own second
   * value, `distance2: null` returns it to the equal-distance form.
   */
  chamfer?: ChamferEditOptions;
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
  };
  revolve?: {
    op: 'add' | 'remove' | 'new';
    /** Sweep angle in degrees; 360 renders no angle argument. */
    angle: ValueExpr;
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
    /** Re-sourced axis; absent keeps the statement's axis text. */
    axis?: RevolveAxisSpec;
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
    /** Instance count, original included (circular). */
    count?: ValueExpr;
    /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
    sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
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
   * Text options, pick-less. The statement's path argument (when present)
   * is re-read at apply time and preserved verbatim; defaults render no
   * chain (size 10, weight 400, upright, left, spacing 1/0).
   */
  text?: {
    text: string;
    size: number;
    font: string | null;
    weight: number;
    italic: boolean;
    align: 'left' | 'center' | 'right';
    lineSpacing: number;
    letterSpacing: number;
  };
};

/**
 * The face an up-to-face extrude ends on when it is not a picked one: the
 * nearest / farthest face the extrusion runs into, which the kernel resolves
 * itself at build time.
 */
export type ExtrudeFaceTarget = 'first-face' | 'last-face';

/**
 * Which face an up-to-face extrude ends on: `selector` a picked one, rendered
 * from the statement's single selector part; the others render as their own
 * literal.
 */
export type ExtrudeTargetKind = 'selector' | ExtrudeFaceTarget;

/** The literal first argument a first/last-face target renders as. */
export function renderFaceTargetExpr(target: ExtrudeFaceTarget): string {
  return `'${target}'`;
}

/**
 * How an extrude statement is rendered and placed. The single producer is the
 * profile *sketch* call. `implicit` inserts at the end of the sketch's scope
 * and consumes it as the last sketch (`extrude(25)`); `bound` binds the sketch
 * to a variable and inserts directly after its statement (`const s = …;
 * extrude(25, s)`) so a later active sketch stays active.
 */
export type ExtrudeEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null renders a through-all `cut()` (remove only). */
  distance: ValueExpr | null;
  /**
   * Opposite-direction distance; non-null renders the two-distance form
   * `extrude(d1, d2)`. Excludes `symmetric` and a through-all `distance`.
   */
  distance2: ValueExpr | null;
  /** `.symmetric()` — the distance is split equally across the sketch plane. */
  symmetric: boolean;
  /** `.draft(angle)` taper in degrees, or null for a straight extrude. */
  draft: ValueExpr | null;
  /** False renders `.drill(false)` — inner closed regions extrude as solid. */
  drill: boolean;
  /** `.thin(a)` / `.thin(a, b)` offsets, or null for a plain extrude. */
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: 'implicit' | 'bound';
  /**
   * Up-to-face mode: the target renders as the call's first argument — the
   * single selector part (a picked face) for `selector`, the literal for
   * `first-face` / `last-face` — as `extrude(<target>[, s])` /
   * `cut(<target>[, s])`, in place of the distance(s). Excludes
   * `distance`/`distance2`/`symmetric`.
   */
  toFace?: ExtrudeTargetKind;
};

/**
 * How a sweep statement is rendered and placed: `sweep(<path>[, <profile>])`
 * plus `.thin(…)` / `.remove()` / `.new()` chains. The profile is a sketch —
 * `implicit` consumes the last sketch (an anchor-only producer verifies it),
 * `{producer}` binds that sketch to a variable. The path is either a bound
 * sketch producer or the selector rendered from `parts` (edge picks). With
 * both ends being sketches and a bound profile, the statement inserts right
 * after the later of the two so a later active sketch stays active; every
 * other combination inserts at end of scope, where an implicit profile is
 * the last sketch and a selector path is known to resolve.
 */
export type SweepEditOptions = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: 'implicit' | { producer: number };
  path: { kind: 'sketch'; producer: number } | { kind: 'selector' };
};

/**
 * How a wrap statement is rendered and placed: `wrap(<thickness>, <sketch>,
 * <face>)` plus `.remove()` / `.new()` chains (wrap has no thin mode). The
 * sketch is always an explicit argument — wrap() never consumes the active
 * sketch — so its producer binds to a variable; the target face is the single
 * selector part. The face selector must resolve on the final model, so the
 * statement always inserts at end of scope.
 */
export type WrapEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Pad thickness along the surface normal (always positive). */
  thickness: ValueExpr;
  sketch: { producer: number };
};

/**
 * Projection payload. Unlike every other 3D-pick feature, the statement does
 * not land in the producers' own scope: `project()` reads the sketch it is
 * called from, so it is written INTO the body of the sketch at `sketch`
 * (the one the toolbar tool was armed in), while its selector parts still
 * name producers declared outside it.
 */
export type ProjectEditOptions = {
  /** Call site of the `sketch()` statement whose body receives the call. */
  sketch: { line: number; column: number };
};

/**
 * One revolve axis: a standard world axis (renders as its string literal, no
 * producer involved), an existing axis statement bound to a variable, or a
 * picked edge — the single selector part wrapped in `axis(…)`.
 */
export type RevolveAxisSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; producer: number }
  | { kind: 'selector' };

/**
 * How a revolve statement is rendered and placed: `revolve(<axis>[, <angle>]
 * [, <profile>])` plus `.thin(…)` / `.remove()` / `.new()` chains. The angle
 * is in degrees; 360 (the API default) renders no argument. The profile is a
 * sketch — `implicit` consumes the last sketch, `bound` binds producers[0] to
 * a variable (the extrude contract: the profile is always producers[0]). A
 * standard axis renders no producer; an axis-statement input binds its
 * producer to a variable; a picked edge renders the single selector part
 * wrapped in `axis(…)`. With every input an explicit variable the statement
 * inserts right after the latest input statement so a later active sketch
 * stays active; a selector axis or an implicit profile forces end-of-scope
 * insertion, where the picked edge is known to resolve.
 */
export type RevolveEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Sweep angle in degrees; 360 renders no angle argument. */
  angle: ValueExpr;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: 'implicit' | 'bound';
  axis: RevolveAxisSpec;
};

/**
 * One helix source: a standard world axis (its string literal, no producer),
 * an existing axis statement bound to a variable, a picked edge — the single
 * selector part wrapped in `axis(…)` — or a picked cylindrical/conical face,
 * the single selector part on its own.
 */
export type HelixSourceSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; producer: number }
  | { kind: 'edge' }
  | { kind: 'face' };

/**
 * How a helix statement is rendered and placed: `helix(<source>)` plus its
 * chained geometry configurators (`.radius()`, `.endRadius()`, `.pitch()`,
 * `.turns()`, `.height()`, `.startOffset()`, `.endOffset()`), each omitted when
 * null. A helix is a wire, so there is no add/remove/new operation. A standard
 * axis renders no producer; an axis-statement source binds its producer to a
 * variable; a picked edge or face renders the single selector part (an edge
 * wrapped in `axis(…)`). A selector source forces end-of-scope insertion where
 * the pick resolves; a bound axis inserts right after its statement.
 */
export type HelixEditOptions = {
  source: HelixSourceSpec;
  radius: ValueExpr | null;
  endRadius: ValueExpr | null;
  pitch: ValueExpr | null;
  turns: ValueExpr | null;
  height: ValueExpr | null;
  startOffset: ValueExpr | null;
  endOffset: ValueExpr | null;
};

/**
 * One repeat axis: a standard world axis (renders as its string literal, no
 * producer involved), an existing axis statement bound to a variable, or a
 * picked edge — its selector part wrapped in `axis(…)`. Part-indexed (unlike
 * the revolve axis) because a two-direction linear repeat can pick two edges.
 */
export type RepeatAxisSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; producer: number }
  | { kind: 'selector'; part: number };

/**
 * The mirror plane of a `repeat('mirror', …)`: a standard origin plane
 * (renders as its string literal, no producer involved), an existing plane
 * feature bound to a variable, or a picked face — its selector part wrapped
 * in `plane(…)`.
 */
export type RepeatPlaneSpec =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; producer: number }
  | { kind: 'selector'; part: number };

/**
 * One axis slot of an edited repeat: keep the statement's own axis text by
 * its position in the parsed `axisTexts` (re-read at apply time, never stale
 * dialog text), or re-source it with any create-mode axis shape.
 */
export type RepeatEditAxis = { kind: 'keep'; sourceIndex: number } | RepeatAxisSpec;

/** The mirror-plane slot of an edited repeat: keep or re-source. */
export type RepeatEditPlane = { kind: 'keep' } | RepeatPlaneSpec;

/**
 * One target of an edited repeat, in argument order: an untouched target by
 * its position in the statement's own argument list (`verbatim` — re-read at
 * apply time), or a re-picked feature statement bound to a producer.
 */
export type RepeatEditTargetSource =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'feature'; producer: number };

/**
 * How a repeat statement is rendered and placed:
 * `repeat('linear', <axis>, { count, offset|length[, centered] }, …targets)`
 * — or, with several directions, the array forms `repeat('linear', [<a1>,
 * <a2>], { count: [c1, c2], offset: [v1, v2] }, …)` —
 * `repeat('circular', <axis>, { count, angle|offset }, …targets)`,
 * `repeat('mirror', <plane>, …targets)`, or
 * `repeat('rotate', <axis>[, angle], …targets)` — the 90° API default renders
 * no angle argument. Targets are the feature statements being repeated, each
 * bound to a variable (featureType `feature` producers — any repeatable
 * builder callee, not just sketches). Every axis takes the revolve axis
 * shapes (standard / axis statement / picked edge as `axis(<selector>)`);
 * the mirror plane mirrors the plane-base shapes. The statement always
 * inserts at end of scope: a repeat replays its targets over the finished
 * model, and a picked selector must resolve there.
 */
export type RepeatEditOptions = {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: RepeatAxisSpec; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** The repeat axis (circular/rotate); linear carries axes per direction. */
  axis?: RepeatAxisSpec;
  /** The mirror plane (mirror only). */
  plane?: RepeatPlaneSpec;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Linear only: center the pattern on the original instance. */
  centered?: boolean;
  /** Rotate only: rotation angle in degrees; 90 renders no argument. */
  angle?: ValueExpr;
  /** The features being repeated, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * How a copy statement is rendered and placed:
 * `copy('linear', <axis>, { count, offset|length[, centered] }, …targets)`
 * — or, with several directions, the array forms `copy('linear', [<a1>,
 * <a2>], { count: [c1, c2], offset: [v1, v2] }, …)` — or
 * `copy('circular', <axis>, { count, angle|offset }, …targets)`. Targets are
 * the feature statements being copied, each bound to a variable (featureType
 * `feature` producers — any repeatable builder callee, not just sketches).
 * Every axis takes the revolve axis shapes (standard / axis statement /
 * picked edge as `axis(<selector>)`). The statement always inserts at end of
 * scope: a copy replays its targets over the finished model, and a picked
 * selector must resolve there.
 */
export type CopyEditOptions = {
  kind: 'linear' | 'circular';
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: RepeatAxisSpec; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** The copy axis (circular); linear carries axes per direction. */
  axis?: RepeatAxisSpec;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Linear only: center the pattern on the original instance. */
  centered?: boolean;
  /** The features being copied, in argument order — bound producers. */
  targets: { producer: number }[];
};

/** The three boolean operations — each its own callee, one shared dialog. */
export type BooleanKind = 'fuse' | 'subtract' | 'common';

/**
 * How a boolean statement is rendered and placed: `fuse(a, b)`,
 * `subtract(base, tool)` or `common(a, b)`. Targets are the solid-bearing
 * feature statements being combined, each bound to a variable (featureType
 * `feature` producers). A subtract takes exactly a base and a tool, in that
 * order; fuse and common take two or more. The statement always inserts at
 * end of scope: a boolean combines its targets over the finished model.
 */
export type BooleanEditOptions = {
  kind: BooleanKind;
  /** The features being combined, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * Mirror of the kernel's `ShellJoinType` — how the inner-wall offset closes
 * corners. 'arc' is the kernel default and renders no chain.
 */
export type ShellJoinKind = 'arc' | 'intersection' | 'tangent';

/**
 * How a shell statement's join type is rendered: a `.join('<type>')` chain
 * after the selector arguments; 'arc' (the kernel default) renders none.
 */
export type ShellEditOptions = {
  joinType: ShellJoinKind;
};

/**
 * A chamfer statement's second value slot — `chamfer(d1, d2, …)` for two
 * distances, `chamfer(d, angle, true, …)` for distance + angle. Null renders
 * the plain equal-distance form.
 */
export type ChamferEditOptions = {
  distance2: ValueExpr | null;
  /** `distance2` is an angle in degrees — renders the `true` third argument. */
  isAngle: boolean;
};

/**
 * How a loft statement is rendered and placed: `loft(<profile>, <profile>, …)`
 * plus `.guides(…)` / `.startCondition(…)` / `.endCondition(…)` /
 * `.thin(…)` / `.remove()` / `.new()` chains. Profiles are ordered —
 * their order IS the argument order. Every profile is explicit (loft never
 * consumes the last sketch): a sketch profile binds its producer to a
 * variable; a selector profile renders one entry of `parts` (a picked face).
 * Guides are always bound sketch producers, at most two — the kernel takes
 * no more — and exclude thin mode (`Loft.validate` throws on the combination).
 * All-sketch lofts insert directly after the latest input statement (guides
 * included — the statement references their variables) so a later active
 * sketch stays active; any selector profile forces end-of-scope insertion,
 * where the picked faces are known to resolve.
 */
export type LoftEditOptions = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profiles: ({ kind: 'sketch'; producer: number } | { kind: 'selector'; part: number })[];
  /** Guide-curve sketches the loft surface must follow, in argument order. */
  guides?: { kind: 'sketch'; producer: number }[];
  /** Takeoff constraint at the first profile; absent renders no chain. */
  startCondition?: LoftConditionSpec;
  /** Arrival constraint at the last profile; absent renders no chain. */
  endCondition?: LoftConditionSpec;
};

/**
 * One rendered `.startCondition(…)`/`.endCondition(…)` chain. 'none' is
 * represented by absence — the API's 'none' merely clears a condition, so the
 * dialog never writes it. A magnitude of 1 (the API default) is omitted.
 */
export type LoftConditionSpec = {
  type: 'normal' | 'tangent';
  magnitude: ValueExpr;
};

/**
 * One base of a plane statement: a standard origin plane (renders as its
 * string literal, no producer involved), a picked face/edge rendered from a
 * `parts` entry, or an existing plane feature bound to a variable.
 */
export type PlaneBaseSpec =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'selector'; part: number }
  | { kind: 'plane'; producer: number }
  /** A helix statement as the edge form's base (its wire is the edge). */
  | { kind: 'wire'; producer: number };

/**
 * How a plane statement is rendered: `plane(<base>)` for an offset plane —
 * with a bare numeric offset (`plane('xy', 10)`) or a transform options
 * object when rotation rides along — `plane(<b1>, <b2>, …)` for a mid plane,
 * or `plane(<edge>, <position>)` for a plane normal to an edge at a 0–1
 * position along it. The bases live apart because an edited statement keeps
 * its own base expressions ({@link PlaneEditBase}) while these values are
 * rewritten wholesale.
 */
export type PlaneValueOptions = {
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null/0 renders none. Offset/mid types only. */
  offset: ValueExpr | null;
  /** Rotation in degrees around the plane's local axes; null/0 renders none. */
  rotateX: ValueExpr | null;
  rotateY: ValueExpr | null;
  rotateZ: ValueExpr | null;
  /** Normalized 0–1 position along the edge (edge type only). */
  position?: ValueExpr | null;
};

/**
 * A created plane statement: its values plus the bases to render, which also
 * decide where it lands. A mid base must be plane-like, so a picked face/edge
 * selector is wrapped in its own `plane(…)` there. With only standard bases
 * the spec carries no producers at all and the statement appends at top
 * level; with plane-variable bases and no selectors it inserts right after
 * the latest input statement; any selector base forces end-of-scope
 * insertion, where the picked geometry is known to resolve.
 */
export type PlaneEditOptions = PlaneValueOptions & {
  /** One base for an offset/edge plane, two for a mid plane. */
  bases: PlaneBaseSpec[];
};

/**
 * One base of an edited plane statement: the statement's own expression by
 * its position in the argument list (`verbatim` — re-read at apply time,
 * never stale text from dialog-open), or any re-sourced create-mode base.
 */
export type PlaneEditBase = { kind: 'verbatim'; sourceIndex: number } | PlaneBaseSpec;

export type ApplyFeatureEditResult = {
  newCode: string;
  error?: string;
};

/**
 * Chain-root callees this transform will bind a variable to. Guards against a
 * stale or clone-inherited source line pointing at some unrelated call (e.g.
 * `repeat(...)`): binding `const e = repeat(...)` and emitting `e.endEdges()`
 * would produce broken code, so we refuse instead.
 */
const PRODUCER_CALLEES = new Set([
  'extrude', 'cut', 'revolve', 'sweep', 'loft', 'rib', 'wrap', 'shell',
]);

/**
 * Chain-root callees a repeat target may reference — any builder returning a
 * repeatable scene feature. Broader than {@link PRODUCER_CALLEES}: a repeat
 * only binds the call to a variable and passes it along (`repeat(…, f)`), it
 * never chains selector accessors onto it, so modifier and primitive calls
 * qualify too.
 */
const REPEAT_TARGET_CALLEES = new Set([
  ...PRODUCER_CALLEES,
  'fillet', 'chamfer', 'draft', 'cylinder', 'sphere', 'helix',
  'fuse', 'subtract', 'common', 'mirror', 'translate', 'rotate',
  'repeat', 'copy', 'load', 'part', 'select',
]);

/**
 * Chain-root callees per 2D sketch-geometry feature type (getType values of
 * sketch primitives). A sketch-scoped spec's producers are statements inside
 * a sketch body; binding one to a variable and chaining `.edge(...)` on it is
 * valid for exactly these callees.
 */
const SKETCH_PRODUCER_CALLEES: Record<string, string[]> = {
  rect: ['rect'],
  line: ['line', 'hLine', 'vLine', 'aLine', 'tLine'],
  circle: ['circle', 'tCircle'],
  ellipse: ['ellipse'],
  polygon: ['polygon'],
  slot: ['slot'],
  arc: ['arc'],
  'arc-from-center': ['arc'],
  tarc: ['tArc'],
  bezier: ['bezier'],
  connect: ['connect'],
  offset: ['offset'],
  projection: ['project'],
  intersect: ['intersect'],
  text: ['text'],
};

/** The chain-root callees producers of `featureType` may bind. */
function producerCallees(featureType: string): Set<string> {
  const sketchCallees = SKETCH_PRODUCER_CALLEES[featureType];
  if (sketchCallees) {
    return new Set(sketchCallees);
  }
  return featureType === 'feature' ? REPEAT_TARGET_CALLEES : PRODUCER_CALLEES;
}

type ProducerBinding = {
  call: TSNode;
  statement: TSNode;
  scope: TSNode;
  varName: string | null;
  needsBinding: boolean;
  /** False for anchor-only entries — never named, never referenced by parts. */
  bind: boolean;
};

/**
 * Apply a synthesized feature statement (fillet/chamfer/shell/sketch) to
 * source text: bind each producer call to a variable (reusing an existing
 * `const`, or prepending `const <name> = ` to a bare expression statement),
 * append the feature statement at the end of the producers' enclosing scope,
 * and ensure the feature is imported. A sketch statement carries an empty
 * multi-line callback body instead of a numeric parameter.
 *
 * Pure string-in/string-out; returns `{ newCode: code, error }` and changes
 * nothing when the edit cannot be applied safely.
 */
export async function applyFeatureEdit(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  if (spec.edit) {
    return applyStatementEdit(code, spec);
  }
  if (spec.feature === 'sketch' && spec.producers.length === 0 && spec.parts.length === 0) {
    return applyPlaneSketch(code, spec.sketchPlane);
  }
  if (spec.feature === 'extrude') {
    // The profile sketch (implicit consumption or a bound variable) is always
    // producers[0]. A picked-face target carries exactly one selector part —
    // the face, whose own producers follow the profile in the list; a distance
    // or first/last-face extrude carries none.
    const valid = spec.extrude !== undefined && spec.producers.length >= 1
      && (spec.extrude.toFace === 'selector'
        ? spec.parts.length === 1
        : spec.producers.length === 1 && spec.parts.length === 0);
    if (!valid) {
      return { newCode: code, error: 'malformed extrude edit spec' };
    }
  } else if (spec.feature === 'sweep') {
    const sw = spec.sweep;
    const valid = sw !== undefined
      && spec.producers.length > 0
      // The path is any wire source (a sketch or a helix); the profile must
      // be a planar sketch.
      && (sw.path.kind === 'selector'
        ? spec.parts.length >= 1
        : spec.parts.length === 0 && isWireProducer(spec, sw.path.producer))
      && (sw.profile === 'implicit' || isSketchProducer(spec, sw.profile.producer));
    if (!valid) {
      return { newCode: code, error: 'malformed sweep edit spec' };
    }
  } else if (spec.feature === 'wrap') {
    // The sketch is always a bound producer (wrap never consumes the active
    // sketch implicitly); the single selector part is the target face, whose
    // own producers ride the list alongside the sketch.
    const wr = spec.wrap;
    const valid = wr !== undefined
      && validValueExpr(wr.thickness, { positive: true })
      && spec.parts.length === 1
      && isSketchProducer(spec, wr.sketch?.producer);
    if (!valid) {
      return { newCode: code, error: 'malformed wrap edit spec' };
    }
  } else if (spec.feature === 'revolve') {
    // The profile sketch (implicit consumption or a bound variable) is always
    // producers[0]. A standard axis involves no other producer; an axis
    // statement binds one; a picked edge carries exactly one selector part,
    // whose own producers follow the profile in the list.
    const rev = spec.revolve;
    const valid = rev !== undefined && spec.producers.length >= 1
      && spec.producers[0].featureType === 'sketch'
      && validValueExpr(rev.angle, { nonzero: true })
      && (rev.axis.kind === 'selector'
        ? spec.parts.length === 1
        : spec.parts.length === 0
          && (rev.axis.kind === 'standard'
            ? spec.producers.length === 1
            : isAxisProducer(spec, rev.axis.producer)));
    if (!valid) {
      return { newCode: code, error: 'malformed revolve edit spec' };
    }
  } else if (spec.feature === 'helix') {
    // A helix consumes no sketch: the source is a standard axis (no producer),
    // an axis statement (one bound producer), or a picked edge/face (exactly
    // one selector part, whose own producers ride the list).
    const hx = spec.helix;
    const valid = hx !== undefined
      && (hx.source.kind === 'edge' || hx.source.kind === 'face'
        ? spec.parts.length === 1
        : spec.parts.length === 0
          && (hx.source.kind === 'standard'
            ? spec.producers.length === 0
            : isAxisProducer(spec, hx.source.producer)));
    if (!valid) {
      return { newCode: code, error: 'malformed helix edit spec' };
    }
    // A standard axis references no existing statement — the helix appends at
    // top level like the pick-less sketch/plane.
    if (spec.producers.length === 0 && spec.parts.length === 0) {
      return appendTopLevelStatement(
        code,
        () => renderHelixStatement(hx, renderHelixSourceExpr(hx.source, spec.parts, () => null)),
        'helix',
        spec.newVariables,
      );
    }
  } else if (spec.feature === 'chamfer') {
    if (!validChamferOptions(spec.chamfer)) {
      return { newCode: code, error: 'malformed chamfer edit spec' };
    }
  } else if (spec.feature === 'loft') {
    const lo = spec.loft;
    const selectorParts = lo?.profiles
      ?.filter((p): p is { kind: 'selector'; part: number } => p?.kind === 'selector')
      .map(p => p.part) ?? [];
    const guides = lo?.guides ?? [];
    const valid = lo !== undefined
      && spec.producers.length > 0
      && Array.isArray(lo.profiles) && lo.profiles.length >= 2
      && lo.profiles.every(p => p?.kind === 'sketch'
        ? isSketchProducer(spec, p.producer)
        : p?.kind === 'selector' && Number.isInteger(p.part) && p.part >= 0 && p.part < spec.parts.length)
      // Every selector part belongs to exactly one profile.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && Array.isArray(guides) && guides.length <= 2
      // A guide is any wire source (a sketch or a helix).
      && guides.every(g => g?.kind === 'sketch' && isWireProducer(spec, g.producer))
      && [lo.startCondition, lo.endCondition].every(c => c === undefined
        || ((c.type === 'normal' || c.type === 'tangent')
          && validValueExpr(c.magnitude, { nonzero: true })));
    if (!valid) {
      return { newCode: code, error: 'malformed loft edit spec' };
    }
    if (guides.length > 0 && lo.thin) {
      return { newCode: code, error: 'loft guides cannot be combined with thin walls' };
    }
  } else if (spec.feature === 'plane') {
    const pl = spec.plane;
    const selectorParts = pl?.bases
      ?.filter((b): b is { kind: 'selector'; part: number } => b?.kind === 'selector')
      .map(b => b.part) ?? [];
    const valid = pl !== undefined
      && Array.isArray(pl.bases)
      && (pl.type === 'mid' ? pl.bases.length === 2
        : (pl.type === 'offset' || pl.type === 'edge') && pl.bases.length === 1)
      && pl.bases.every(b =>
        b?.kind === 'standard' ? (b.plane === 'xy' || b.plane === 'xz' || b.plane === 'yz')
          : b?.kind === 'plane' ? isPlaneProducer(spec, b.producer)
            // A wire base (a helix's edge) belongs to the edge form only.
            : b?.kind === 'wire' ? (pl.type === 'edge' && isWireProducer(spec, b.producer))
              : b?.kind === 'selector' && Number.isInteger(b.part) && b.part >= 0 && b.part < spec.parts.length)
      // Every selector part belongs to exactly one base.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ]
        .every(v => v === null || validValueExpr(v))
      // The edge form is an edge source (a picked edge or a helix) plus a
      // normalized position — the second argument slot is taken, so no
      // offset/rotation can ride.
      && (pl.type !== 'edge' || (
        (pl.bases[0]?.kind === 'selector' || pl.bases[0]?.kind === 'wire')
        && pl.position !== null && pl.position !== undefined
        && validValueExpr(pl.position)
        && (typeof pl.position !== 'number' || (pl.position >= 0 && pl.position <= 1))
        && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ].every(v => v === null)));
    if (!valid) {
      return { newCode: code, error: 'malformed plane edit spec' };
    }
    // Standard-only bases involve no existing statement — the plane appends
    // at top level like the pick-less sketch.
    if (spec.producers.length === 0 && spec.parts.length === 0) {
      return appendTopLevelStatement(
        code,
        () => renderPlaneStatement(pl, renderPlaneBaseExprs(pl, spec.parts, () => null)),
        'plane',
        spec.newVariables,
      );
    }
  } else if (spec.feature === 'repeat') {
    // Every target is a bound feature producer; each picked axis edge or
    // mirror face references its own selector part, and every part must
    // belong to exactly one such input — the parts' producers ride the list
    // alongside the targets.
    const rp = spec.repeat;
    const targets = rp?.targets ?? [];
    const selectorParts: number[] = [];
    const validPart = (part: number): boolean => {
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return false;
      }
      selectorParts.push(part);
      return true;
    };
    const validAxis = (axis: RepeatAxisSpec | undefined): boolean =>
      axis !== undefined && (axis.kind === 'selector'
        ? validPart(axis.part)
        : axis.kind === 'standard'
          ? axis.axis === 'x' || axis.axis === 'y' || axis.axis === 'z'
          : isAxisProducer(spec, axis.producer));
    const validPlane = (plane: RepeatPlaneSpec | undefined): boolean =>
      plane !== undefined && (plane.kind === 'selector'
        ? validPart(plane.part)
        : plane.kind === 'standard'
          ? plane.plane === 'xy' || plane.plane === 'xz' || plane.plane === 'yz'
          : isPlaneProducer(spec, plane.producer));
    const validSweep = rp?.sweep !== undefined
      && (rp.sweep.mode === 'angle' || rp.sweep.mode === 'offset')
      && validValueExpr(rp.sweep.value, { nonzero: true });
    const validDirections = Array.isArray(rp?.directions) && rp!.directions!.length >= 1
      && rp!.directions!.every(d => validAxis(d?.axis)
        && validCountValue(d.count)
        && validValueExpr(d.value, { nonzero: true }));
    const valid = rp !== undefined
      && targets.length >= 1
      && targets.every(t => isFeatureProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && (rp.kind === 'linear'
        ? validDirections && (rp.spacingMode === 'offset' || rp.spacingMode === 'length')
          && rp.axis === undefined && rp.plane === undefined
          && rp.count === undefined && rp.sweep === undefined && rp.angle === undefined
        : rp.kind === 'circular'
          ? validAxis(rp.axis) && rp.plane === undefined && rp.directions === undefined
            && validCountValue(rp.count) && validSweep
            && rp.spacingMode === undefined && rp.angle === undefined
          : rp.kind === 'mirror'
            ? validPlane(rp.plane) && rp.axis === undefined && rp.directions === undefined
              && rp.count === undefined && rp.spacingMode === undefined
              && rp.sweep === undefined && rp.angle === undefined
            : rp.kind === 'rotate'
              && validAxis(rp.axis) && rp.plane === undefined && rp.directions === undefined
              && validValueExpr(rp.angle, { nonzero: true })
              && rp.count === undefined && rp.spacingMode === undefined && rp.sweep === undefined)
      // Every selector part belongs to exactly one axis/plane input.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length;
    if (!valid) {
      return { newCode: code, error: 'malformed repeat edit spec' };
    }
  } else if (spec.feature === 'copy') {
    // Every target is a bound feature producer; each picked axis edge
    // references its own selector part, and every part must belong to
    // exactly one axis — the parts' producers ride the list alongside the
    // targets.
    const cp = spec.copy;
    const targets = cp?.targets ?? [];
    const selectorParts: number[] = [];
    const validPart = (part: number): boolean => {
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return false;
      }
      selectorParts.push(part);
      return true;
    };
    const validAxis = (axis: RepeatAxisSpec | undefined): boolean =>
      axis !== undefined && (axis.kind === 'selector'
        ? validPart(axis.part)
        : axis.kind === 'standard'
          ? axis.axis === 'x' || axis.axis === 'y' || axis.axis === 'z'
          : isAxisProducer(spec, axis.producer));
    const validSweep = cp?.sweep !== undefined
      && (cp.sweep.mode === 'angle' || cp.sweep.mode === 'offset')
      && validValueExpr(cp.sweep.value, { nonzero: true });
    const validDirections = Array.isArray(cp?.directions) && cp!.directions!.length >= 1
      && cp!.directions!.every(d => validAxis(d?.axis)
        && validCountValue(d.count)
        && validValueExpr(d.value, { nonzero: true }));
    const valid = cp !== undefined
      && targets.length >= 1
      && targets.every(t => isFeatureProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && (cp.kind === 'linear'
        ? validDirections && (cp.spacingMode === 'offset' || cp.spacingMode === 'length')
          && cp.axis === undefined && cp.count === undefined && cp.sweep === undefined
        : cp.kind === 'circular'
          && validAxis(cp.axis) && cp.directions === undefined
          && validCountValue(cp.count) && validSweep
          && cp.spacingMode === undefined && cp.centered === undefined)
      // Every selector part belongs to exactly one axis input.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length;
    if (!valid) {
      return { newCode: code, error: 'malformed copy edit spec' };
    }
  } else if (spec.feature === 'boolean') {
    // Every target is a bound feature producer; booleans render no selector
    // parts at all. A subtract takes exactly a base and a tool; fuse and
    // common take two or more.
    const bo = spec.boolean;
    const targets = bo?.targets ?? [];
    const valid = bo !== undefined
      && (bo.kind === 'fuse' || bo.kind === 'subtract' || bo.kind === 'common')
      && (bo.kind === 'subtract' ? targets.length === 2 : targets.length >= 2)
      && targets.every(t => isFeatureProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && spec.parts.length === 0;
    if (!valid) {
      return { newCode: code, error: 'malformed boolean edit spec' };
    }
  } else if (spec.feature === 'sketch' && spec.sketchOnPlane) {
    // The single producer is the plane statement the sketch targets; there is
    // no selector to render.
    const valid = spec.producers.length === 1 && isPlaneProducer(spec, 0) && spec.parts.length === 0;
    if (!valid) {
      return { newCode: code, error: 'malformed sketch-on-plane edit spec' };
    }
  } else if (spec.feature === 'project') {
    // The selector parts are ordinary 3D picks; what the payload adds is the
    // sketch call site whose body receives the statement.
    const pj = spec.project;
    const valid = pj !== undefined
      && Number.isInteger(pj.sketch?.line) && Number.isInteger(pj.sketch?.column)
      && spec.producers.length > 0 && spec.parts.length > 0;
    if (!valid) {
      return { newCode: code, error: 'malformed project edit spec' };
    }
  } else if (!spec.producers.length || !spec.parts.length) {
    return { newCode: code, error: 'empty edit spec' };
  }
  if (spec.feature === 'sketch' && spec.parts.length > 1 && !spec.rawArgs?.trim()) {
    return { newCode: code, error: 'sketch takes a single face selection' };
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);

  const resolved = resolveProducerBindings(tree, lines, spec);
  if ('error' in resolved) {
    return { newCode: code, error: resolved.error };
  }
  const bindings = resolved.bindings;
  const scope = bindings[0].scope;

  allocateNames(tree.rootNode, bindings, spec);

  const insertion = resolveInsertion(spec, bindings, scope, lines, tree);
  if ('error' in insertion) {
    return { newCode: code, error: insertion.error };
  }
  let statementText = buildStatement(spec, bindings, insertion.indent);
  const useSemicolon = bindings.some(b => b.statement.text.trimEnd().endsWith(';'));

  type Edit = { index: number; text: string };
  const hoistEdits: Edit[] = [];
  // A projection's global `select(…)` arguments must run OUTSIDE the sketch
  // body — select captures whatever container it executes in, so from inside
  // the sketch callback it resolves against the sketch's own scope and the
  // projection silently drops. Lift each to a declaration before the sketch.
  if (spec.feature === 'project') {
    const hoisted = await hoistProjectSelects(statementText, spec, bindings, tree, lines, useSemicolon);
    if ('error' in hoisted) {
      return { newCode: code, error: hoisted.error };
    }
    statementText = hoisted.statement;
    hoistEdits.push(...hoisted.edits);
  }

  // Declarations a dialog expression field committed land directly before
  // the statement, at its indent.
  const declsResult = renderNewVariableDecls(code, spec.newVariables, useSemicolon);
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  const block = [...declsResult.decls, statementText + (useSemicolon ? ';' : '')]
    .join(`\n${insertion.indent}`);

  const edits: Edit[] = [
    { index: insertion.index, text: insertion.wrap(block) },
    ...hoistEdits,
  ];
  for (const binding of bindings) {
    if (binding.needsBinding) {
      edits.push({ index: binding.call.startIndex, text: `const ${binding.varName} = ` });
    }
  }
  edits.sort((a, b) => b.index - a.index);

  let result = code;
  for (const edit of edits) {
    result = spliceCode(result, edit.index, edit.index, edit.text);
  }

  result = await ensureSymbolImport(result, statementCallee(spec));
  const imports = new Set(spec.imports ?? []);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      imports.add(symbol);
    }
  }
  if (declsResult.paramDecls.length > 0) {
    imports.add('param');
  }
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
  result = await insertDeclsAfterImports(result, declsResult.paramDecls);
  return { newCode: result };
}

/**
 * The pick-less sketch statement: no face selector — `sketch('<plane>', ()
 * => {})` on an origin plane (bare `sketch(() => {})` when no plane rides
 * the spec), appended at top level.
 */
async function applyPlaneSketch(
  code: string,
  plane: 'xy' | 'xz' | 'yz' | undefined,
): Promise<ApplyFeatureEditResult> {
  const args = plane ? `'${plane}', ` : '';
  return appendTopLevelStatement(code, indent => `sketch(${args}() => {\n\n${indent}})`, 'sketch');
}

/**
 * Append a statement that references no existing code (pick-less sketch,
 * standard-base plane) after the file's last statement — before the first
 * `breakpoint();` (a paused build never runs statements after it) or a
 * trailing `return`, matching the file's semicolon style — or as an empty
 * file's first. `statementFor` receives the insertion indent (for multi-line
 * bodies) and renders without the trailing semicolon.
 */
async function appendTopLevelStatement(
  code: string,
  statementFor: (indent: string) => string,
  callee: string,
  newVariables?: ApplyFeatureEditSpec['newVariables'],
): Promise<ApplyFeatureEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const children = tree.rootNode.namedChildren;
  const last = children.length > 0 ? children[children.length - 1] : null;
  const useSemicolon = children.some(c => c.text.trimEnd().endsWith(';'));

  // Declarations a dialog expression field committed land directly before
  // the statement, at its indent.
  const declsResult = renderNewVariableDecls(code, newVariables, useSemicolon);
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  const block = (indent: string) => [...declsResult.decls, `${statementFor(indent)}${useSemicolon ? ';' : ''}`]
    .join(`\n${indent}`);

  let result: string;
  if (!last) {
    result = spliceCode(code, code.length, code.length,
      [...declsResult.decls, `${statementFor('')};`].join('\n') + '\n');
  } else {
    const before = children.find(isBreakpointStatement)
      ?? (last.type === 'return_statement' ? last : null);
    const indent = indentOf(lines, (before ?? last).startPosition.row);
    result = before
      ? spliceCode(code, before.startIndex, before.startIndex, `${block(indent)}\n${indent}`)
      : spliceCode(code, last.endIndex, last.endIndex, `\n${indent}${block(indent)}`);
  }
  result = await ensureSymbolImport(result, callee);
  if (declsResult.paramDecls.length > 0) {
    result = await ensureSymbolImport(result, 'param');
    result = await insertDeclsAfterImports(result, declsResult.paramDecls);
  }
  return { newCode: result };
}

/**
 * Build a synchronous producer→name lookup over `code` for the synthesis
 * preview, using exactly the binding rules `applyFeatureEdit` applies:
 * reuse an existing `const` name, otherwise allocate the hint suffixed past
 * every identifier already in the file. Returning the same names the
 * transform will write keeps the previewed expression (and any
 * selectorOverride the user types against it) truthful. Producers this can't
 * resolve (stale line, non-producer callee, nested call) map to null and the
 * synthesis falls back to plain hint names.
 */
export async function makeProducerNamer(
  code: string,
): Promise<(producers: { line: number; nameHint: string; featureType?: string }[]) => (string | null)[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);

  const fileIdentifiers = new Set<string>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'identifier'
      || node.type === 'property_identifier'
      || node.type === 'shorthand_property_identifier') {
      fileIdentifiers.add(node.text);
    }
  }

  return (producers) => {
    const used = new Set(fileIdentifiers);
    return producers.map(producer => {
      const call = findEditableCallAt(tree, lines, producer.line);
      if (!call) {
        return null;
      }
      const root = chainRootCallee(call);
      // Sketch/plane/wire producers must name their own call — the pick
      // features never attribute to one, so the looser callee stays scoped
      // by type.
      const requiredRoots = requiredChainRoots(producer.featureType ?? '');
      const valid = requiredRoots
        ? root !== null && requiredRoots.includes(root)
        : root !== null && producerCallees(producer.featureType ?? '').has(root);
      if (!valid) {
        return null;
      }
      const resolved = resolveStatement(call);
      if ('error' in resolved) {
        return null;
      }
      if (!resolved.needsBinding && resolved.varName) {
        return resolved.varName;
      }
      const hint = producer.nameHint || 'f';
      let name = hint;
      let suffix = 1;
      while (used.has(name)) {
        suffix++;
        name = `${hint}${suffix}`;
      }
      used.add(name);
      return name;
    });
  };
}

/**
 * The variable names statements of `callee` are bound to, for dialog labels:
 * `const spine = sketch(…)` at one of `lines` resolves to `'spine'`; a bare
 * statement, a different callee at the line, or an unparsable one resolves to
 * null. Purely cosmetic — the transform re-resolves bindings at apply time.
 */
export async function resolveSketchNames(
  code: string,
  lines: number[],
  callee: string = 'sketch',
): Promise<(string | null)[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const srcLines = splitLines(code);
  return lines.map(line => {
    const call = findEditableCallAt(tree, srcLines, line);
    if (!call || chainRootCallee(call) !== callee) {
      return null;
    }
    const resolved = resolveStatement(call);
    if ('error' in resolved || resolved.needsBinding) {
      return null;
    }
    return resolved.varName;
  });
}

export type ExtractedParam = {
  name: string;
  value: number;
  /** Set for `param("Label", 12)` declarations — resolve against the registry. */
  label?: string;
};

/** Numeric literal text of a node, accepting a unary minus. */
function numericLiteralText(node: TSNode): string | null {
  if (node.type === 'number') {
    return node.text;
  }
  if (node.type === 'unary_expression' && node.text.startsWith('-')
    && node.namedChildren.length === 1 && node.namedChildren[0].type === 'number') {
    return node.text;
  }
  return null;
}

/**
 * Extract the file's top-level numeric constants for parameter linking:
 * synthesis renders a dimension constant as the user's variable when the
 * values match exactly. Two initializer forms qualify — a plain numeric
 * literal (`const height = 30`) and a `param("Label", 12)` declaration
 * (which returns the resolved number at runtime; the label lets the caller
 * substitute the registry's current, override-aware value). Only
 * program-root declarations qualify — they are in scope wherever the
 * feature statement is inserted; function-local variables are skipped
 * rather than risking a reference error.
 */
export async function extractNumericParams(code: string): Promise<ExtractedParam[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const params: ExtractedParam[] = [];

  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
      continue;
    }
    for (const declarator of statement.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (!name || name.type !== 'identifier' || !value) {
        continue;
      }

      const literal = numericLiteralText(value);
      if (literal !== null) {
        const parsed = Number(literal);
        if (Number.isFinite(parsed)) {
          params.push({ name: name.text, value: parsed });
        }
        continue;
      }

      // const x = param("Label", 12[, ...]) — link by the param's value.
      if (value.type === 'call_expression') {
        const fn = value.childForFieldName('function');
        const args = value.childForFieldName('arguments');
        if (!fn || fn.type !== 'identifier' || fn.text !== 'param' || !args) {
          continue;
        }
        const [labelNode, defaultNode] = args.namedChildren;
        if (!labelNode || labelNode.type !== 'string' || !defaultNode) {
          continue;
        }
        const defaultText = numericLiteralText(defaultNode);
        if (defaultText === null) {
          continue;
        }
        const parsed = Number(defaultText);
        if (Number.isFinite(parsed)) {
          params.push({
            name: name.text,
            value: parsed,
            label: labelNode.text.slice(1, -1),
          });
        }
      }
    }
  }
  return params;
}

/**
 * Replace `param()`-declared defaults with the registry's current values —
 * the scene was built with those, so linking against the source default when
 * an override is active would emit a filter that matches nothing. Params
 * whose current value is not a finite number (select/text) never link; a
 * label the registry doesn't know keeps the source default.
 */
export function resolveParamValues(
  entries: ExtractedParam[],
  definitions: { label: string; currentValue: unknown }[],
): { name: string; value: number }[] {
  const byLabel = new Map(definitions.map(d => [d.label, d.currentValue]));
  const resolved: { name: string; value: number }[] = [];
  for (const entry of entries) {
    if (entry.label === undefined || !byLabel.has(entry.label)) {
      resolved.push({ name: entry.name, value: entry.value });
      continue;
    }
    const current = byLabel.get(entry.label);
    if (typeof current === 'number' && Number.isFinite(current)) {
      resolved.push({ name: entry.name, value: current });
    }
  }
  return resolved;
}

/** Whether producer index `i` is a valid sketch producer of `spec`. */
function isSketchProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'sketch';
}

/**
 * Whether producer index `i` is a valid wire producer of `spec` — a sketch
 * or a helix, for the slots that consume a bare wire (a sweep path, a loft
 * guide). Plain 'sketch' is accepted too: it is a strictly narrower claim.
 */
function isWireProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && (spec.producers[i].featureType === 'wire' || spec.producers[i].featureType === 'sketch');
}

/** Whether producer index `i` is a valid plane producer of `spec`. */
function isPlaneProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'plane';
}

/** Whether producer index `i` is a valid axis producer of `spec`. */
function isAxisProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'axis';
}

/** Whether producer index `i` is a valid repeat-target feature producer. */
function isFeatureProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'feature';
}

/**
 * Producer feature types whose source line must hold exactly one of these
 * calls — sketch, plane, axis and wire inputs are referenced by identity, so
 * any other callee at the line means the file is out of sync. A 'wire' input
 * (a sweep path, a loft guide) is either a sketch or a helix. Null falls
 * back to the general `PRODUCER_CALLEES` allowlist.
 */
function requiredChainRoots(featureType: string): string[] | null {
  if (featureType === 'sketch') {
    return ['sketch'];
  }
  if (featureType === 'plane') {
    return ['plane'];
  }
  if (featureType === 'axis') {
    return ['axis'];
  }
  if (featureType === 'wire') {
    return ['sketch', 'helix'];
  }
  return null;
}

/**
 * web-tree-sitter mints a fresh wrapper object on every node access, so
 * reference equality between wrappers is meaningless — compare by span.
 */
function sameNode(a: TSNode, b: TSNode): boolean {
  return a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** Root identifier of a call chain: `extrude(10).drill()` → `extrude`. */
function chainRootCallee(call: TSNode): string | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return fn.text;
    }
    if (fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Locate the statement holding the producer call and how to bind it:
 * - `const x = <call>` → reuse `x` (statement is the declaration, or the
 *   `export` statement wrapping it);
 * - `<call>;` as a bare expression statement → prepend `const <name> = `
 *   (same-row prepend, so later source lines don't shift);
 * - anything else (the call is nested inside another expression) → refuse
 *   rather than rewrite user code speculatively.
 */
function resolveStatement(call: TSNode): Omit<ProducerBinding, 'bind'> | { error: string } {
  const parent = call.parent;
  const valueOfDeclarator = parent?.type === 'variable_declarator'
    ? parent.childForFieldName('value')
    : null;
  if (parent && valueOfDeclarator && sameNode(valueOfDeclarator, call)) {
    const nameNode = parent.childForFieldName('name');
    if (!nameNode || nameNode.type !== 'identifier') {
      return { error: 'the producing call is bound by a destructuring pattern — cannot reuse its variable' };
    }
    let statement = parent.parent;
    if (!statement) {
      return { error: 'malformed declaration around the producing call' };
    }
    if (statement.parent && statement.parent.type === 'export_statement') {
      statement = statement.parent;
    }
    const scope = enclosingScope(statement);
    return { call, statement, scope, varName: nameNode.text, needsBinding: false };
  }

  if (parent && parent.type === 'expression_statement') {
    const scope = enclosingScope(parent);
    return { call, statement: parent, scope, varName: null, needsBinding: true };
  }

  return {
    error: 'the producing call is nested inside another expression — '
      + 'assign it to a variable first, then retry',
  };
}

/**
 * Resolve every producer of `spec` to its statement and binding plan —
 * shared by create mode (insert a new statement) and edit mode (re-source an
 * existing one). Bindings must share one scope: one statement executes in
 * one place. Also validates that every selector part references a bound
 * producer.
 */
function resolveProducerBindings(
  tree: TSTree,
  lines: string[],
  spec: ApplyFeatureEditSpec,
): { bindings: ProducerBinding[] } | { error: string } {
  const bindings: ProducerBinding[] = [];
  for (const producer of spec.producers) {
    const call = findEditableCallAt(tree, lines, producer.line);
    if (!call) {
      return { error: `no call found at line ${producer.line} — is the file in sync with the last render?` };
    }

    // Sketch, plane and wire producers (profiles, paths, plane bases) must
    // anchor their own call in both modes — a stale line pointing at some
    // other call would consume the wrong input.
    const requiredRoots = requiredChainRoots(producer.featureType);
    if (requiredRoots) {
      const root = chainRootCallee(call);
      if (root === null || !requiredRoots.includes(root)) {
        return {
          error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
            + `expected a ${requiredRoots.map(r => `${r}()`).join(' or ')} call — is the file in sync with the last render?`,
        };
      }
    }

    if (!producer.bind) {
      // Anchor-only: the statement locates the insertion scope for a
      // select()-based edit. No variable is bound, so any statement will do —
      // but the scope must be one that runs once per build, not a loop body,
      // hence the walk up to the enclosing function body (or module root).
      const statement = enclosingStatement(call);
      if (!statement) {
        return { error: `no statement found at line ${producer.line}` };
      }
      const scope = enclosingFunctionScope(statement);
      bindings.push({ call, statement, scope, varName: null, needsBinding: false, bind: false });
      continue;
    }

    const root = chainRootCallee(call);
    const validCallee = requiredRoots
      ? root !== null && requiredRoots.includes(root)
      : root !== null && producerCallees(producer.featureType).has(root);
    if (!validCallee) {
      return {
        error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
          + `expected a ${producer.featureType}()-producing call`,
      };
    }

    const resolved = resolveStatement(call);
    if ('error' in resolved) {
      return { error: resolved.error };
    }
    bindings.push({ ...resolved, bind: true });
  }

  const scope = bindings.length > 0 ? bindings[0].scope : null;
  for (const binding of bindings) {
    if (!sameNode(binding.scope, scope!)) {
      return { error: 'the picked edges come from features in different scopes' };
    }
  }

  for (const part of spec.parts) {
    if (part.producer !== null && !spec.producers[part.producer]?.bind) {
      return { error: 'malformed edit spec: a selector part references an unbound producer' };
    }
  }

  return { bindings };
}

/** Nearest enclosing statement_block or the program root. */
function enclosingScope(node: TSNode): TSNode {
  let current: TSNode | null = node.parent;
  while (current) {
    if (current.type === 'statement_block' || current.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return node;
}

/** Nearest ancestor that is a direct child of a statement_block or program. */
function enclosingStatement(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current && current.parent) {
    if (current.parent.type === 'statement_block' || current.parent.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function', 'generator_function_declaration',
]);

/**
 * Nearest enclosing scope that executes once per build: a function body or
 * the program root, skipping loop/conditional statement blocks. A statement
 * inserted at the end of this scope runs after the whole model is built.
 */
function enclosingFunctionScope(node: TSNode): TSNode {
  let scope = enclosingScope(node);
  while (scope.type === 'statement_block') {
    const parent = scope.parent;
    if (parent && FUNCTION_NODE_TYPES.has(parent.type)) {
      return scope;
    }
    scope = enclosingScope(scope);
  }
  return scope;
}

/**
 * Pick collision-free variable names for producers that need binding.
 * Collision-checked against every identifier in the file, matching how the
 * lint pass walks identifiers.
 */
function allocateNames(root: TSNode, bindings: ProducerBinding[], spec: ApplyFeatureEditSpec): void {
  const used = new Set<string>();
  for (const node of walkTree(root)) {
    if (node.type === 'identifier'
      || node.type === 'property_identifier'
      || node.type === 'shorthand_property_identifier') {
      used.add(node.text);
    }
  }

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (!binding.needsBinding) {
      continue;
    }
    const hint = spec.producers[i].nameHint || 'f';
    let name = hint;
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `${hint}${suffix}`;
    }
    used.add(name);
    binding.varName = name;
  }
}

/** The function the rendered statement calls — extrude's remove op is `cut()`. */
function statementCallee(spec: ApplyFeatureEditSpec): string {
  if (spec.feature === 'extrude') {
    return spec.extrude!.op === 'remove' ? 'cut' : 'extrude';
  }
  if (spec.feature === 'boolean') {
    return spec.boolean!.kind;
  }
  return spec.feature;
}

/** The `.thin(…)` / `.remove()` / `.new()` chains shared by sweep and loft. */
function renderOpChains(opts: {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
}): string {
  let chains = '';
  if (opts.thin) {
    chains += `.thin(${opts.thin.map(formatValue).join(', ')})`;
  }
  if (opts.op === 'remove') {
    chains += '.remove()';
  } else if (opts.op === 'new') {
    chains += '.new()';
  }
  return chains;
}

/**
 * Render a sweep statement: `sweep(<path>[, <profile>])` plus `.thin(…)` and
 * the `.remove()` / `.new()` operation chains. Shared with the route's
 * preview so the previewed text is exactly what the transform writes.
 */
export function renderSweepStatement(
  sw: Pick<SweepEditOptions, 'op' | 'thin'>,
  pathExpr: string,
  profileVar: string | null,
): string {
  const args = [pathExpr];
  if (profileVar) {
    args.push(profileVar);
  }
  return `sweep(${args.join(', ')})` + renderOpChains(sw);
}

/**
 * Render a wrap statement: `wrap(<thickness>, <sketch>, <face>)` plus the
 * `.remove()` / `.new()` operation chains (wrap has no thin mode). Shared
 * with the route's preview so the previewed text is exactly what the
 * transform writes.
 */
export function renderWrapStatement(
  wr: Pick<WrapEditOptions, 'op' | 'thickness'>,
  sketchExpr: string,
  faceExpr: string,
): string {
  return `wrap(${formatValue(wr.thickness)}, ${sketchExpr}, ${faceExpr})`
    + renderOpChains({ op: wr.op, thin: null });
}

/**
 * Render a text statement: `text("…"[, <path>])` plus the option chains, in
 * the Text tool's canonical order, defaults omitted. `pathExpr` is the
 * statement's own path argument text, preserved verbatim. Shared with the
 * route's preview so the previewed text is exactly what the transform writes.
 */
export function renderTextStatement(
  opts: NonNullable<FeatureStatementEditTarget['text']>,
  pathExpr: string | null,
): string {
  const args = [JSON.stringify(opts.text)];
  if (pathExpr) {
    args.push(pathExpr);
  }
  let statement = `text(${args.join(', ')})`;
  if (opts.font) {
    statement += `.font('${opts.font.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
  }
  if (opts.size !== 10) {
    statement += `.size(${formatNumber(opts.size)})`;
  }
  if (opts.weight === 700) {
    statement += '.bold()';
  } else if (opts.weight !== 400) {
    statement += `.weight(${opts.weight})`;
  }
  if (opts.italic) {
    statement += '.italic()';
  }
  if (opts.align !== 'left') {
    statement += `.align('${opts.align}')`;
  }
  if (opts.lineSpacing !== 1) {
    statement += `.lineSpacing(${formatNumber(opts.lineSpacing)})`;
  }
  if (opts.letterSpacing !== 0) {
    statement += `.letterSpacing(${formatNumber(opts.letterSpacing)})`;
  }
  return statement;
}

/**
 * Render a revolve statement: `revolve(<axis>[, <angle>][, <profile>])` plus
 * `.thin(…)` and the `.remove()` / `.new()` operation chains. The 360° API
 * default renders no angle argument. Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderRevolveStatement(
  rev: Pick<RevolveEditOptions, 'op' | 'angle' | 'thin'>,
  axisExpr: string,
  profileExpr: string | null,
): string {
  const args = [axisExpr];
  if (rev.angle !== 360) {
    args.push(formatValue(rev.angle));
  }
  if (profileExpr) {
    args.push(profileExpr);
  }
  return `revolve(${args.join(', ')})` + renderOpChains(rev);
}

/**
 * Render a revolve's axis argument: `'z'` for a standard world axis, the
 * bound variable for an existing axis statement, or the picked edge's
 * selector part wrapped in `axis(…)`. Shared with the route, which passes
 * its namer's variables; the transform passes its bindings'.
 */
export function renderRevolveAxisExpr(
  axis: RevolveAxisSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (axis.kind === 'standard') {
    return `'${axis.axis}'`;
  }
  if (axis.kind === 'axis') {
    return varFor(axis.producer) ?? 'a';
  }
  const part = parts[0];
  return `axis(${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer))})`;
}

/** A helix's chained geometry configurators — shared by its create and edit payloads. */
type HelixChainOptions = {
  radius: ValueExpr | null;
  endRadius: ValueExpr | null;
  pitch: ValueExpr | null;
  turns: ValueExpr | null;
  height: ValueExpr | null;
  startOffset: ValueExpr | null;
  endOffset: ValueExpr | null;
};

/**
 * Render a helix's chained configurators in canonical order — `.radius()`,
 * `.endRadius()`, `.pitch()`, `.turns()`, `.height()`, `.startOffset()`,
 * `.endOffset()` — each omitted when null.
 */
function renderHelixChains(hx: HelixChainOptions): string {
  let chains = '';
  if (hx.radius !== null) {
    chains += `.radius(${formatValue(hx.radius)})`;
  }
  if (hx.endRadius !== null) {
    chains += `.endRadius(${formatValue(hx.endRadius)})`;
  }
  if (hx.pitch !== null) {
    chains += `.pitch(${formatValue(hx.pitch)})`;
  }
  if (hx.turns !== null) {
    chains += `.turns(${formatValue(hx.turns)})`;
  }
  if (hx.height !== null) {
    chains += `.height(${formatValue(hx.height)})`;
  }
  if (hx.startOffset !== null) {
    chains += `.startOffset(${formatValue(hx.startOffset)})`;
  }
  if (hx.endOffset !== null) {
    chains += `.endOffset(${formatValue(hx.endOffset)})`;
  }
  return chains;
}

/**
 * Render a helix statement: `helix(<source>)` plus its geometry chains. Shared
 * with the route's preview so the previewed text is exactly what the transform
 * writes.
 */
export function renderHelixStatement(hx: HelixChainOptions, sourceExpr: string): string {
  return `helix(${sourceExpr})` + renderHelixChains(hx);
}

/**
 * Render a helix's source argument: `'z'` for a standard world axis, the bound
 * variable for an axis statement, the picked edge's selector wrapped in
 * `axis(…)`, or the picked face's selector on its own. Shared with the route,
 * which passes its namer's variables; the transform passes its bindings'.
 */
export function renderHelixSourceExpr(
  source: HelixSourceSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (source.kind === 'standard') {
    return `'${source.axis}'`;
  }
  if (source.kind === 'axis') {
    return varFor(source.producer) ?? 'a';
  }
  const part = parts[0];
  const selector = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
  return source.kind === 'edge' ? `axis(${selector})` : selector;
}

/**
 * Render a repeat statement from its rendered axis/plane input and target
 * expressions: `repeat('linear', 'x', { count: 3, offset: 40 }, e)` — or the
 * array forms with several directions, `repeat('linear', ['x', a], { count:
 * [3, 2], offset: [40, 30] }, e)` — `repeat('circular', a, { count: 6,
 * angle: 360 }, e)`, `repeat('mirror', 'yz', e, f)`, `repeat('rotate', 'z',
 * 45, e)` — the 90° rotate default renders no angle argument. `inputExprs`
 * is one axis expression per linear direction; a single-element list
 * everywhere else. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderRepeatStatement(
  rp: Pick<RepeatEditOptions, 'kind' | 'spacingMode' | 'centered' | 'count' | 'sweep' | 'angle'>
    & { directions?: { count: ValueExpr; value: ValueExpr }[] },
  inputExprs: string[],
  targetExprs: string[],
): string {
  const single = inputExprs.length === 1;
  const args = [`'${rp.kind}'`, single ? inputExprs[0] : `[${inputExprs.join(', ')}]`];
  if (rp.kind === 'linear') {
    const counts = rp.directions!.map(d => formatValue(d.count));
    const values = rp.directions!.map(d => formatValue(d.value));
    const entries = [
      `count: ${single ? counts[0] : `[${counts.join(', ')}]`}`,
      `${rp.spacingMode}: ${single ? values[0] : `[${values.join(', ')}]`}`,
    ];
    if (rp.centered) {
      entries.push('centered: true');
    }
    args.push(`{ ${entries.join(', ')} }`);
  } else if (rp.kind === 'circular') {
    args.push(`{ count: ${formatValue(rp.count)}, ${rp.sweep!.mode}: ${formatValue(rp.sweep!.value)} }`);
  } else if (rp.kind === 'rotate' && rp.angle !== 90) {
    args.push(formatValue(rp.angle));
  }
  return `repeat(${[...args, ...targetExprs].join(', ')})`;
}

/**
 * Render one repeat axis argument: `'z'` for a standard world axis, the
 * bound variable for an existing axis statement, or the picked edge's
 * selector part wrapped in `axis(…)`. Shared with the route, which passes
 * its namer's variables; the transform passes its bindings'.
 */
export function renderRepeatAxisExpr(
  axis: RepeatAxisSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (axis.kind === 'standard') {
    return `'${axis.axis}'`;
  }
  if (axis.kind === 'axis') {
    return varFor(axis.producer) ?? 'a';
  }
  const part = parts[axis.part];
  return `axis(${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer))})`;
}

/**
 * Render a repeat's mirror-plane argument: `'xy'` for a standard origin
 * plane, the bound variable for an existing plane feature, or the picked
 * face's selector part wrapped in `plane(…)` — `resolvePlane` needs a
 * plane-like, so the raw selection is lifted the way a mid plane's base is.
 * Shared with the route, which passes its namer's variables; the transform
 * passes its bindings'.
 */
export function renderRepeatPlaneExpr(
  plane: RepeatPlaneSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (plane.kind === 'standard') {
    return `'${plane.plane}'`;
  }
  if (plane.kind === 'plane') {
    return varFor(plane.producer) ?? 'p';
  }
  const part = parts[plane.part];
  return `plane(${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer))})`;
}

/**
 * Render a copy statement from its rendered axis input and target
 * expressions: `copy('linear', 'x', { count: 3, offset: 40 }, e)` — or the
 * array forms with several directions, `copy('linear', ['x', a], { count:
 * [3, 2], offset: [40, 30] }, e)` — or `copy('circular', a, { count: 6,
 * angle: 360 }, e)`. `inputExprs` is one axis expression per linear
 * direction; a single-element list for circular. Shared with the route's
 * preview so the previewed text is exactly what the transform writes.
 */
export function renderCopyStatement(
  cp: Pick<CopyEditOptions, 'kind' | 'spacingMode' | 'centered' | 'count' | 'sweep'>
    & { directions?: { count: ValueExpr; value: ValueExpr }[] },
  inputExprs: string[],
  targetExprs: string[],
): string {
  const single = inputExprs.length === 1;
  const args = [`'${cp.kind}'`, single ? inputExprs[0] : `[${inputExprs.join(', ')}]`];
  if (cp.kind === 'linear') {
    const counts = cp.directions!.map(d => formatValue(d.count));
    const values = cp.directions!.map(d => formatValue(d.value));
    const entries = [
      `count: ${single ? counts[0] : `[${counts.join(', ')}]`}`,
      `${cp.spacingMode}: ${single ? values[0] : `[${values.join(', ')}]`}`,
    ];
    if (cp.centered) {
      entries.push('centered: true');
    }
    args.push(`{ ${entries.join(', ')} }`);
  } else {
    args.push(`{ count: ${formatValue(cp.count)}, ${cp.sweep!.mode}: ${formatValue(cp.sweep!.value)} }`);
  }
  return `copy(${[...args, ...targetExprs].join(', ')})`;
}

/**
 * Render a boolean statement from its target expressions: `fuse(a, b)`,
 * `subtract(base, tool)` or `common(a, b)`. Shared with the route's preview
 * so the previewed text is exactly what the transform writes.
 */
export function renderBooleanStatement(kind: BooleanKind, targetExprs: string[]): string {
  return `${kind}(${targetExprs.join(', ')})`;
}

/**
 * Render a loft statement from its ordered profile expressions: `loft(s, s2)`
 * plus `.guides(g)`, `.startCondition('normal')` / `.endCondition('tangent',
 * 2)` (the default magnitude 1 is omitted), and the `.thin(…)` / `.remove()`
 * / `.new()` chains. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderLoftStatement(
  lo: Pick<LoftEditOptions, 'op' | 'thin' | 'startCondition' | 'endCondition'>,
  profileExprs: string[],
  guideExprs: string[] = [],
): string {
  let statement = `loft(${profileExprs.join(', ')})`;
  if (guideExprs.length > 0) {
    statement += `.guides(${guideExprs.join(', ')})`;
  }
  statement += renderConditionChain('startCondition', lo.startCondition);
  statement += renderConditionChain('endCondition', lo.endCondition);
  return statement + renderOpChains(lo);
}

function renderConditionChain(method: string, condition: LoftConditionSpec | undefined): string {
  if (!condition) {
    return '';
  }
  const magnitude = condition.magnitude === 1 ? '' : `, ${formatValue(condition.magnitude)}`;
  return `.${method}('${condition.type}'${magnitude})`;
}

/**
 * Render a shell's `.join('<type>')` chain; 'arc' (the kernel default) and
 * absence render nothing. Shared with the route's preview so the previewed
 * text is exactly what the transform writes.
 */
export function renderShellJoinChain(joinType: ShellJoinKind | undefined): string {
  if (!joinType || joinType === 'arc') {
    return '';
  }
  return `.join('${joinType}')`;
}

/**
 * Render one selector part as an expression: `select(<args>)` for a global
 * part, `<var>.<accessor>(<args>)` on a bound producer. Shared with the
 * route, which renders loft profiles part-by-part with the namer's names.
 */
export function renderSelectorPartExpr(
  part: ApplyFeatureEditSpec['parts'][number],
  producerVar: string | null,
): string {
  const selectorArgs = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
  if (part.producer === null) {
    // 'filter' parts are bare edge-filter arguments (2D ops accept them
    // directly); everything else producer-less is a global select().
    if (part.accessor === 'filter') {
      return selectorArgs;
    }
    return `select(${selectorArgs})`;
  }
  // An empty accessor names the whole feature (`fillet(4, l)`).
  if (part.accessor === '') {
    return `${producerVar}`;
  }
  return `${producerVar}.${part.accessor}(${selectorArgs})`;
}

/**
 * Render an extrude statement from its options: `extrude(25)` / `cut()`
 * (through-all) / `extrude(10, 20)` (two distances) / `extrude(25, s)` for a
 * bound profile / `extrude(<faceExpr>)` for an up-to-face extrude — a picked
 * face's selector or a `'first-face'` / `'last-face'` literal — plus
 * `.symmetric()` / `.draft(…)` / `.drill(false)` / `.thin(…)` / `.new()`
 * chains. Shared with the route's preview so the previewed text is exactly
 * what the transform writes.
 */
export function renderExtrudeStatement(
  ext: ExtrudeEditOptions,
  profileVar: string | null,
  faceExpr: string | null = null,
): string {
  const callee = ext.op === 'remove' ? 'cut' : 'extrude';
  const callArgs: string[] = [];
  if (faceExpr !== null) {
    callArgs.push(faceExpr);
  } else if (ext.distance !== null) {
    callArgs.push(formatValue(ext.distance));
    if (ext.distance2 !== null) {
      callArgs.push(formatValue(ext.distance2));
    }
  }
  if (ext.profile === 'bound') {
    callArgs.push(profileVar ?? 's');
  }
  let statement = `${callee}(${callArgs.join(', ')})`;
  if (ext.symmetric) {
    statement += '.symmetric()';
  }
  if (ext.draft !== null) {
    statement += `.draft(${formatValue(ext.draft)})`;
  }
  if (!ext.drill) {
    // True is the API default, so only the opt-out is written.
    statement += '.drill(false)';
  }
  if (ext.thin) {
    statement += `.thin(${ext.thin.map(formatValue).join(', ')})`;
  }
  if (ext.op === 'new') {
    statement += '.new()';
  }
  return statement;
}

/**
 * Render a plane statement from its rendered base expressions:
 * `plane('xy')` / `plane('xy', 10)` (offset only keeps the bare-number
 * shorthand) / `plane(e.endFaces(), { offset: 10, rotateX: 15 })` /
 * `plane(p, 'xz', { rotateY: 30 })` (mid). Shared with the route's preview so
 * the previewed text is exactly what the transform writes.
 */
export function renderPlaneStatement(pl: PlaneValueOptions, baseExprs: string[]): string {
  if (pl.type === 'edge') {
    // The second argument is the normalized position, not an offset — the
    // edge form takes no transform options.
    return `plane(${baseExprs[0]}, ${formatValue(pl.position ?? 0)})`;
  }
  const entries: string[] = [];
  if (pl.offset !== null && pl.offset !== 0) {
    entries.push(`offset: ${formatValue(pl.offset)}`);
  }
  const rotations: [string, ValueExpr | null][] = [
    ['rotateX', pl.rotateX], ['rotateY', pl.rotateY], ['rotateZ', pl.rotateZ],
  ];
  let hasRotation = false;
  for (const [key, value] of rotations) {
    if (value !== null && value !== 0) {
      hasRotation = true;
      entries.push(`${key}: ${formatValue(value)}`);
    }
  }
  let optionsArg = '';
  if (entries.length > 0) {
    optionsArg = !hasRotation && pl.type === 'offset'
      ? `, ${formatValue(pl.offset!)}`
      : `, { ${entries.join(', ')} }`;
  }
  return `plane(${baseExprs.join(', ')}${optionsArg})`;
}

/**
 * Render one plane base as an expression: `'xy'` for a standard plane, the
 * bound variable for an existing plane/helix feature, or the selector part
 * for a picked face/edge. A mid plane needs plane-like arguments, so a raw
 * selector is wrapped in its own `plane(…)` there — the same lift an edited
 * statement's kept selector base gets.
 */
export function renderPlaneBaseExpr(
  base: PlaneBaseSpec,
  type: PlaneValueOptions['type'],
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (base.kind === 'standard') {
    return `'${base.plane}'`;
  }
  if (base.kind === 'plane') {
    return varFor(base.producer) ?? 'p';
  }
  if (base.kind === 'wire') {
    return varFor(base.producer) ?? 'h';
  }
  const part = parts[base.part];
  const expr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
  return type === 'mid' ? `plane(${expr})` : expr;
}

/**
 * Render a created plane's base expressions, in argument order. Shared with
 * the route, which passes its namer's variables; the transform passes its
 * bindings'.
 */
export function renderPlaneBaseExprs(
  pl: PlaneEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string[] {
  return pl.bases.map(base => renderPlaneBaseExpr(base, pl.type, parts, varFor));
}

/**
 * Render the feature statement. Most features are
 * `<feature>(<value>, <selectors>)`; `sketch` instead wraps the selector with
 * an empty callback body — a blank line for the user's first sketch entity,
 * with the closing brace at the statement's own indent; `extrude` renders
 * from its options — `extrude(25)` / `cut()` (through-all) / a bound profile
 * variable as the trailing argument — plus `.thin(…)` and `.new()` chains.
 */
function buildStatement(spec: ApplyFeatureEditSpec, bindings: ProducerBinding[], indent: string): string {
  if (spec.feature === 'extrude') {
    const target = spec.extrude!.toFace;
    let faceExpr: string | null = null;
    if (target === 'selector') {
      const part = spec.parts[0];
      faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName);
    } else if (target !== undefined) {
      faceExpr = renderFaceTargetExpr(target);
    }
    return renderExtrudeStatement(spec.extrude!, bindings[0].varName, faceExpr);
  }
  if (spec.feature === 'sweep') {
    const sw = spec.sweep!;
    const pathExpr = sw.path.kind === 'sketch'
      ? bindings[sw.path.producer].varName!
      : renderSelectorArgs(spec, bindings);
    const profileVar = sw.profile === 'implicit' ? null : bindings[sw.profile.producer].varName!;
    return renderSweepStatement(sw, pathExpr, profileVar);
  }
  if (spec.feature === 'wrap') {
    const wr = spec.wrap!;
    const part = spec.parts[0];
    const faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName);
    return renderWrapStatement(wr, bindings[wr.sketch.producer].varName ?? 's', faceExpr);
  }
  if (spec.feature === 'revolve') {
    const rev = spec.revolve!;
    const axisExpr = renderRevolveAxisExpr(rev.axis, spec.parts, i => bindings[i].varName);
    return renderRevolveStatement(rev, axisExpr, rev.profile === 'bound' ? bindings[0].varName : null);
  }
  if (spec.feature === 'helix') {
    const hx = spec.helix!;
    const sourceExpr = renderHelixSourceExpr(hx.source, spec.parts, i => bindings[i].varName);
    return renderHelixStatement(hx, sourceExpr);
  }
  if (spec.feature === 'repeat') {
    const rp = spec.repeat!;
    const varFor = (i: number): string | null => bindings[i].varName;
    const inputExprs = rp.kind === 'mirror'
      ? [renderRepeatPlaneExpr(rp.plane!, spec.parts, varFor)]
      : rp.kind === 'linear'
        ? rp.directions!.map(d => renderRepeatAxisExpr(d.axis, spec.parts, varFor))
        : [renderRepeatAxisExpr(rp.axis!, spec.parts, varFor)];
    return renderRepeatStatement(rp, inputExprs, rp.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'copy') {
    const cp = spec.copy!;
    const varFor = (i: number): string | null => bindings[i].varName;
    const inputExprs = cp.kind === 'linear'
      ? cp.directions!.map(d => renderRepeatAxisExpr(d.axis, spec.parts, varFor))
      : [renderRepeatAxisExpr(cp.axis!, spec.parts, varFor)];
    return renderCopyStatement(cp, inputExprs, cp.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'boolean') {
    const bo = spec.boolean!;
    return renderBooleanStatement(bo.kind, bo.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'loft') {
    const lo = spec.loft!;
    const profileExprs = lo.profiles.map(profile => {
      if (profile.kind === 'sketch') {
        return bindings[profile.producer].varName!;
      }
      const part = spec.parts[profile.part];
      return renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName);
    });
    const guideExprs = (lo.guides ?? []).map(guide => bindings[guide.producer].varName!);
    return renderLoftStatement(lo, profileExprs, guideExprs);
  }
  if (spec.feature === 'plane') {
    const pl = spec.plane!;
    return renderPlaneStatement(
      pl, renderPlaneBaseExprs(pl, spec.parts, i => bindings[i].varName),
    );
  }
  if (spec.feature === 'sketch' && spec.sketchOnPlane) {
    return `sketch(${bindings[0].varName}, () => {\n\n${indent}})`;
  }
  const args = renderSelectorArgs(spec, bindings);
  if (spec.feature === 'sketch') {
    return `sketch(${args}, () => {\n\n${indent}})`;
  }
  if (spec.feature === 'chamfer') {
    return `chamfer(${renderChamferValueArgs(spec.value, spec.chamfer)}, ${args})`;
  }
  // The 2D sketch booleans, whole-edge trim and project carry no numeric
  // parameter — the args ARE the statement (`fuse(r, c)`, `trim(r.edge('top'))`,
  // `project(e.face('top'))`). The boolean kinds are distinct from the 3D
  // 'boolean' spec, whose targets are top-level feature statements.
  if (spec.feature === 'fuse' || spec.feature === 'subtract' || spec.feature === 'common'
    || spec.feature === 'trim' || spec.feature === 'project') {
    return `${spec.feature}(${args})`;
  }
  const joinChain = spec.feature === 'shell' ? renderShellJoinChain(spec.shell?.joinType) : '';
  return `${spec.feature}(${formatValue(spec.value)}, ${args})${joinChain}`;
}

/** The selector argument list: the user-edited override, or rendered parts. */
function renderSelectorArgs(spec: ApplyFeatureEditSpec, bindings: ProducerBinding[]): string {
  const rawArgs = spec.rawArgs?.trim();
  return rawArgs ?? spec.parts
    .map(part => renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName))
    .join(', ');
}

const MODULE_FOR_IMPORT: Record<string, string> = {
  select: 'fluidcad/core',
  edge: 'fluidcad/filters',
  face: 'fluidcad/filters',
  axis: 'fluidcad/core',
  param: 'fluidcad/core',
};

/**
 * Symbols a user-edited argument list references. The synthesized path
 * computes imports kernel-side; an override is free text, so they are
 * re-derived here from the same three call spellings.
 */
function importsForRawArgs(rawArgs: string): string[] {
  const symbols: string[] = [];
  for (const symbol of Object.keys(MODULE_FOR_IMPORT)) {
    if (new RegExp(`\\b${symbol}\\(`).test(rawArgs)) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

function formatNumber(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : '1';
}

/** A ValueExpr slot's rendering: a number literal, or the expression verbatim. */
function formatValue(value: ValueExpr | undefined | null): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return formatNumber(value ?? undefined);
}

/**
 * An optional chamfer payload's shape: no payload, an explicit equal-distance
 * form (`distance2: null`), a positive second distance, or an angle in the
 * open (0, 90) — the kernel's chamfer angle range. Expression text passes;
 * the build reports its range errors.
 */
function validChamferOptions(chamfer: ChamferEditOptions | undefined): boolean {
  if (chamfer === undefined) {
    return true;
  }
  if (typeof chamfer.isAngle !== 'boolean') {
    return false;
  }
  if (chamfer.distance2 === null) {
    return !chamfer.isAngle;
  }
  if (!validValueExpr(chamfer.distance2, { positive: true })) {
    return false;
  }
  return !chamfer.isAngle || typeof chamfer.distance2 !== 'number' || chamfer.distance2 < 90;
}

/**
 * A chamfer statement's value arguments: `d`, `d1, d2`, or `d, angle, true`.
 * Shared by the create transform, the in-place edit, and the route's preview
 * so every rendering of the second-value overloads agrees.
 */
export function renderChamferValueArgs(value: ValueExpr | undefined, chamfer: ChamferEditOptions | undefined): string {
  const distance = formatValue(value);
  if (chamfer?.distance2 === undefined || chamfer.distance2 === null) {
    return distance;
  }
  const second = formatValue(chamfer.distance2);
  return chamfer.isAngle ? `${distance}, ${second}, true` : `${distance}, ${second}`;
}

/**
 * The `const <name> = <initializer>` lines `spec.newVariables` asks for —
 * validated to safe shapes, deduplicated, and filtered against names the
 * file already declares so a re-apply stays idempotent. Declarations whose
 * initializer calls `param()` come back separately in `paramDecls` — those
 * land at top level after the imports, not before the statement.
 */
function renderNewVariableDecls(
  code: string,
  newVariables: ApplyFeatureEditSpec['newVariables'],
  semicolon: boolean,
): { decls: string[]; paramDecls: string[] } | { error: string } {
  if (!newVariables || newVariables.length === 0) {
    return { decls: [], paramDecls: [] };
  }
  const decls: string[] = [];
  const paramDecls: string[] = [];
  const seen = new Set<string>();
  for (const nv of newVariables) {
    if (!nv || typeof nv.name !== 'string' || !/^[a-zA-Z_$][\w$]*$/.test(nv.name)
      || !isExpressionText(nv.initializer)) {
      return { error: 'malformed new-variable declaration' };
    }
    if (seen.has(nv.name)) {
      continue;
    }
    seen.add(nv.name);
    const escaped = nv.name.replace(/\$/g, '\\$');
    if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`).test(code)) {
      continue;
    }
    const target = /\bparam\s*\(/.test(nv.initializer) ? paramDecls : decls;
    target.push(`const ${nv.name} = ${nv.initializer.trim()}${semicolon ? ';' : ''}`);
  }
  return { decls, paramDecls };
}

/** Splice top-level declarations directly after the file's last import (or
 * as the file's first lines) — where `param()` declarations live. */
async function insertDeclsAfterImports(code: string, decls: string[]): Promise<string> {
  if (decls.length === 0) {
    return code;
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  let lastImport: TSNode | null = null;
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === 'import_statement') {
      lastImport = child;
    }
  }
  const text = decls.join('\n');
  return lastImport
    ? spliceCode(code, lastImport.endIndex, lastImport.endIndex, `\n${text}`)
    : `${text}\n${code}`;
}

/** Insertion point directly after `statement`, at its own indent. */
function afterStatementInsertion(
  statement: TSNode,
  lines: string[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  const indent = indentOf(lines, statement.startPosition.row);
  return { index: statement.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}

/**
 * Where the feature statement goes. Statements whose inputs are all explicit
 * sketch variables insert directly after the latest input — a later active
 * sketch stays the active one (bound-profile extrude; bound-profile sweep
 * with a sketch path; all-sketch loft). Everything else inserts at end of
 * scope: a selector must resolve on the final model, and an implicit profile
 * must consume the scope's last sketch.
 */
type Insertion = { index: number; indent: string; wrap: (stmt: string) => string };

function resolveInsertion(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  scope: TSNode,
  lines: string[],
  tree: TSTree,
): Insertion | { error: string } {
  // A projection reads the sketch it is called from, so it lands inside that
  // sketch's body rather than in the producers' scope.
  if (spec.feature === 'project') {
    return resolveSketchBodyInsertion(spec.project!.sketch, bindings, lines, tree);
  }
  // An up-to-face extrude resolves its target against the model — a picked
  // face's selector, or the first/last face the extrusion runs into — so it
  // goes at end of scope, even with a bound profile.
  if (spec.feature === 'extrude' && spec.extrude!.profile === 'bound' && !spec.extrude!.toFace) {
    return afterStatementInsertion(bindings[0].statement, lines);
  }
  if (spec.feature === 'sweep') {
    const sw = spec.sweep!;
    if (sw.path.kind === 'sketch' && sw.profile !== 'implicit') {
      const path = bindings[sw.path.producer].statement;
      const profile = bindings[sw.profile.producer].statement;
      return afterStatementInsertion(path.endIndex >= profile.endIndex ? path : profile, lines);
    }
  }
  if (spec.feature === 'revolve' && spec.revolve!.profile === 'bound') {
    const rev = spec.revolve!;
    // A picked-edge axis references a selector, which must resolve on the
    // final model — end of scope, even with a bound profile.
    if (rev.axis.kind === 'standard') {
      return afterStatementInsertion(bindings[0].statement, lines);
    }
    if (rev.axis.kind === 'axis') {
      const profile = bindings[0].statement;
      const axis = bindings[rev.axis.producer].statement;
      return afterStatementInsertion(axis.endIndex >= profile.endIndex ? axis : profile, lines);
    }
  }
  if (spec.feature === 'helix') {
    const hx = spec.helix!;
    // An axis-statement source binds one producer — insert right after it so a
    // later active sketch stays active. A picked edge/face references a
    // selector that must resolve on the final model, so it falls through to
    // end-of-scope insertion.
    if (hx.source.kind === 'axis') {
      return afterStatementInsertion(bindings[hx.source.producer].statement, lines);
    }
  }
  if (spec.feature === 'plane') {
    // Selector-free bases are explicit plane/helix variables (standard-only
    // specs never reach here — they append at top level with no producers at
    // all): insert right after the latest input statement.
    const planeBases = spec.plane!.bases
      .filter((b): b is { kind: 'plane' | 'wire'; producer: number } =>
        b.kind === 'plane' || b.kind === 'wire');
    if (planeBases.length > 0 && spec.plane!.bases.every(b => b.kind !== 'selector')) {
      const latest = planeBases
        .map(b => bindings[b.producer].statement)
        .reduce((a, b) => (b.endIndex >= a.endIndex ? b : a));
      return afterStatementInsertion(latest, lines);
    }
  }
  if (spec.feature === 'loft') {
    const sketches = spec.loft!.profiles
      .filter((p): p is { kind: 'sketch'; producer: number } => p.kind === 'sketch');
    if (sketches.length === spec.loft!.profiles.length) {
      // Guides are inputs too — the statement references their variables, so
      // it must land after the latest of profiles AND guides.
      const latest = [...sketches, ...(spec.loft!.guides ?? [])]
        .map(p => bindings[p.producer].statement)
        .reduce((a, b) => (b.endIndex >= a.endIndex ? b : a));
      return afterStatementInsertion(latest, lines);
    }
  }
  return findInsertionPoint(scope, lines, bindings);
}

/**
 * Insertion at the end of a sketch's callback body — the projection tool's
 * target. The bound producers stay where they are (outside the sketch), so
 * the statement only type-checks if their declarations already precede the
 * sketch call: a solid built *after* the sketch cannot be projected into it,
 * and saying so beats emitting code that dies in the temporal dead zone.
 */
function resolveSketchBodyInsertion(
  sketchLoc: { line: number; column: number },
  bindings: ProducerBinding[],
  lines: string[],
  tree: TSTree,
): Insertion | { error: string } {
  const call = findEditableCallAt(tree, lines, sketchLoc.line);
  if (!call || chainRootCallee(call) !== 'sketch') {
    return {
      error: `no sketch() call found at line ${sketchLoc.line} — is the file in sync with the last render?`,
    };
  }
  const body = findSketchBody(call);
  if (!body) {
    return { error: 'the sketch at that line has no callback body to project into' };
  }

  const sketchStatement = enclosingStatement(call) ?? call;
  const late = bindings.find(b => b.bind && b.statement.startIndex >= sketchStatement.startIndex);
  if (late) {
    return {
      error: 'the picked geometry is built after this sketch — only features declared '
        + 'before the sketch can be projected into it',
    };
  }

  const children = body.namedChildren;
  const last = children.length > 0 ? children[children.length - 1] : null;
  if (last) {
    const indent = indentOf(lines, last.startPosition.row);
    return { index: last.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
  }
  // An empty body: open the first line of it at one level in from the sketch.
  const indent = indentOf(lines, body.startPosition.row) + '  ';
  return { index: body.startIndex + 1, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}

/**
 * Lift the global `select(…)` arguments of a freshly built `project(…)`
 * statement out of the sketch body. `select()` registers a scene-wide query
 * against the container it runs in, so called from inside the sketch callback
 * it captures the sketch's own (empty of solids) scope and resolves to
 * nothing — the projection silently drops. Each `select(…)` call is moved to
 * a `const` on the line before the sketch statement (where it sees the whole
 * model, like every other selection) and referenced by name inside project().
 *
 * Producer-accessor arguments (`box.sideFaces(0)`) stay inline: they only read
 * a producer already declared above the sketch, registering nothing. Returns
 * the (possibly rewritten) statement plus the declaration edits to apply.
 */
async function hoistProjectSelects(
  statementText: string,
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  tree: TSTree,
  lines: string[],
  useSemicolon: boolean,
): Promise<{ statement: string; edits: { index: number; text: string }[] } | { error: string }> {
  const parser = await getJavaScriptParser();
  // `project(<args>)` is itself a valid call expression — parse it directly to
  // find the select() calls among its arguments.
  const stmtTree = parser.parse(statementText);
  const selects: TSNode[] = [];
  for (const node of walkTree(stmtTree.rootNode)) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'identifier' && fn.text === 'select') {
        selects.push(node);
      }
    }
  }
  if (selects.length === 0) {
    return { statement: statementText, edits: [] };
  }

  // The declarations go on the line before the sketch statement the call
  // lands in, at its indent.
  const sketchCall = findEditableCallAt(tree, lines, spec.project!.sketch.line);
  if (!sketchCall) {
    return {
      error: `no sketch() call found at line ${spec.project!.sketch.line} — is the file in sync with the last render?`,
    };
  }
  const sketchStatement = enclosingStatement(sketchCall) ?? sketchCall;
  const sketchIndent = indentOf(lines, sketchStatement.startPosition.row);

  // Names already taken: every identifier in the file plus the producer
  // variables this same edit is about to introduce.
  const used = new Set<string>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'identifier' || node.type === 'property_identifier'
      || node.type === 'shorthand_property_identifier') {
      used.add(node.text);
    }
  }
  for (const binding of bindings) {
    if (binding.varName) {
      used.add(binding.varName);
    }
  }

  // Name each select() in source order (stable `sel`, `sel2`, … numbering),
  // then splice the statement descending so earlier spans keep their offsets.
  const inSourceOrder = [...selects].sort((a, b) => a.startIndex - b.startIndex);
  const nameByNode = new Map<TSNode, string>();
  for (const node of inSourceOrder) {
    let name = 'sel';
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `sel${suffix}`;
    }
    used.add(name);
    nameByNode.set(node, name);
  }

  let statement = statementText;
  for (const node of [...selects].sort((a, b) => b.startIndex - a.startIndex)) {
    statement = spliceCode(statement, node.startIndex, node.endIndex, nameByNode.get(node)!);
  }
  const decls = inSourceOrder
    .map(node => `const ${nameByNode.get(node)} = ${node.text}${useSemicolon ? ';' : ''}`)
    .join(`\n${sketchIndent}`);
  return {
    statement,
    edits: [{ index: sketchStatement.startIndex, text: `${decls}\n${sketchIndent}` }],
  };
}

// ---------------------------------------------------------------------------
// In-place statement editing (timeline double-click → edit dialog)
// ---------------------------------------------------------------------------

/** Feature kinds whose statements the edit dialogs can rewrite in place. */
export type EditableFeatureKind = 'extrude' | 'sweep' | 'loft' | 'shell' | 'fillet' | 'chamfer' | 'revolve' | 'text' | 'wrap' | 'sketch' | 'repeat' | 'copy' | 'boolean' | 'helix' | 'plane';

/**
 * One base argument of a parsed plane statement. `kind` is what the base
 * READS AS, from its text and (for a plain identifier) the statement it
 * resolves to: 'plane' for a plane-like — an origin-plane literal, a plane
 * variable, a nested `plane(…)` — 'edge' for an edge source (an edge
 * selector or a helix variable), 'face' for anything else. It decides the
 * form the statement opens in, which dialog types can keep the base, and
 * whether keeping it into a mid plane needs the `plane(…)` lift.
 */
export type ParsedPlaneBase = {
  /** Argument text, verbatim. */
  text: string;
  kind: 'plane' | 'face' | 'edge';
  /** The origin plane when the text is a standard plane literal. */
  standard: 'xy' | 'xz' | 'yz' | null;
  /**
   * Source location of the feature statement a plain-identifier base
   * references (the bound call's own position — what its timeline row
   * reports), or null when the expression doesn't resolve to one; lets the
   * edit dialog seed the base as its plane/helix row.
   */
  ref: { line: number; column: number } | null;
};

/**
 * An existing statement's dialog-editable reading. Argument expressions the
 * dialogs don't edit (profiles, paths, selector args) are carried as
 * verbatim source text and re-emitted unchanged; numeric options must be
 * plain literals — a variable distance is edited through the params panel,
 * not this dialog.
 */
export type ParsedFeatureStatement =
  | {
    feature: 'extrude';
    op: 'add' | 'remove' | 'new';
    /** null = through-all remove (`cut()` with no distance). */
    distance: ValueExpr | null;
    /** Second distance of a two-distance `extrude(d1, d2)`, or null. */
    distance2: ValueExpr | null;
    symmetric: boolean;
    /** `.draft(angle)` taper in degrees, or null when the chain is absent. */
    draft: ValueExpr | null;
    drill: boolean;
    thin: [ValueExpr] | null;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
    /** Up-to-face target argument text, or null for a distance extrude. */
    toFaceText: string | null;
    /**
     * The target's kind — a picked face's selector, or the first/last-face
     * literal; null for a distance extrude.
     */
    toFaceKind: ExtrudeTargetKind | null;
  }
  | {
    feature: 'sweep';
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | null;
    pathText: string;
    profileText: string | null;
  }
  | {
    feature: 'wrap';
    op: 'add' | 'remove' | 'new';
    /** Pad thickness along the surface normal (always positive). */
    thickness: ValueExpr;
    /** Sketch argument text, verbatim (`s`). */
    sketchText: string;
    /** Target face argument text, verbatim (`e.sideFaces(0)`). */
    faceText: string;
  }
  | {
    feature: 'revolve';
    op: 'add' | 'remove' | 'new';
    /** Sweep angle in degrees; null = omitted (the 360° API default). */
    angle: ValueExpr | null;
    thin: [ValueExpr] | null;
    /** Axis argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`). */
    axisText: string;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
  }
  | {
    feature: 'helix';
    /** Source argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`, `e.sideFaces(0)`). */
    sourceText: string;
    /** The tab the dialog opens on — a face selector reads as 'face', all else 'axis'. */
    sourceMode: 'axis' | 'face';
    radius: ValueExpr | null;
    endRadius: ValueExpr | null;
    pitch: ValueExpr | null;
    turns: ValueExpr | null;
    height: ValueExpr | null;
    startOffset: ValueExpr | null;
    endOffset: ValueExpr | null;
  }
  | {
    feature: 'loft';
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | null;
    profileTexts: string[];
    guideTexts: string[];
    startCondition: LoftConditionSpec | null;
    endCondition: LoftConditionSpec | null;
  }
  | {
    feature: 'shell';
    value: ValueExpr;
    /** Selector argument list after the value, verbatim (`''` when absent). */
    argsText: string;
    /** `.join()` type; 'arc' (the kernel default) when the chain is absent. */
    joinType: ShellJoinKind;
  }
  | {
    feature: 'fillet';
    value: ValueExpr;
    /** Selector argument list after the value, verbatim (`''` when absent). */
    argsText: string;
  }
  | {
    feature: 'chamfer';
    value: ValueExpr;
    /** Selector argument list after the value slots, verbatim (`''` when absent). */
    argsText: string;
    /** Second distance (or angle) argument; null for the equal-distance form. */
    distance2: ValueExpr | null;
    /** The literal `true` third argument — `distance2` is an angle in degrees. */
    isAngle: boolean;
  }
  | {
    feature: 'sketch';
    /** Plane/face target argument text, verbatim; null for the bare form. */
    targetText: string | null;
    /** The body callback argument text, verbatim — never dialog-edited. */
    bodyText: string;
  }
  | {
    feature: 'text';
    text: string;
    size: number;
    /** `.font()` family/file, or null when the chain is absent. */
    font: string | null;
    weight: number;
    italic: boolean;
    align: 'left' | 'center' | 'right';
    lineSpacing: number;
    letterSpacing: number;
    /** Second argument (a path expression), verbatim; null for plain text. */
    pathText: string | null;
  }
  | {
    feature: 'repeat';
    kind: 'linear' | 'circular' | 'mirror' | 'rotate';
    /**
     * Axis argument texts, verbatim — one per linear direction, a single
     * entry for circular/rotate, empty for mirror.
     */
    axisTexts: string[];
    /** Mirror plane argument text, verbatim; null for the axis kinds. */
    planeText: string | null;
    /** Linear per-direction count and value, in axis order. */
    directions: { count: ValueExpr; value: ValueExpr }[] | null;
    /** Linear spacing semantics shared by every direction. */
    spacingMode: 'offset' | 'length' | null;
    /** Linear only: the pattern is centered on the original instance. */
    centered: boolean;
    /** Circular instance count, original included. */
    count: ValueExpr | null;
    /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
    sweep: { mode: 'angle' | 'offset'; value: ValueExpr } | null;
    /** Rotate angle in degrees; null = omitted (the 90° API default). */
    angle: ValueExpr | null;
    /** Trailing target texts, verbatim; empty replays the previous feature. */
    targetTexts: string[];
    /**
     * Per-target source location of the feature statement a plain-identifier
     * target references (the bound call's own position — what its timeline
     * row reports), or null when the expression doesn't resolve to one. Same
     * length as `targetTexts`; lets the edit dialog seed targets as their
     * timeline rows.
     */
    targetRefs: ({ line: number; column: number } | null)[];
  }
  | {
    feature: 'copy';
    kind: 'linear' | 'circular';
    /**
     * Axis argument texts, verbatim — one per linear direction, a single
     * entry for circular.
     */
    axisTexts: string[];
    /** Linear per-direction count and value, in axis order. */
    directions: { count: ValueExpr; value: ValueExpr }[] | null;
    /** Linear spacing semantics shared by every direction. */
    spacingMode: 'offset' | 'length' | null;
    /** Linear only: the pattern is centered on the original instance. */
    centered: boolean;
    /** Circular instance count, original included. */
    count: ValueExpr | null;
    /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
    sweep: { mode: 'angle' | 'offset'; value: ValueExpr } | null;
    /** Trailing target texts, verbatim; empty replays the previous feature. */
    targetTexts: string[];
    /**
     * Per-target source location of the feature statement a plain-identifier
     * target references, or null when the expression doesn't resolve to one.
     * Same length as `targetTexts`; lets the edit dialog seed targets as
     * their timeline rows.
     */
    targetRefs: ({ line: number; column: number } | null)[];
  }
  | {
    feature: 'plane';
    /**
     * The form the dialog opens on: two bases read as a mid plane, a lone
     * edge base carrying a position as the edge form, everything else as an
     * offset plane.
     */
    type: 'offset' | 'mid' | 'edge';
    /** The base arguments, in argument order: one, or two for a mid plane. */
    bases: ParsedPlaneBase[];
    /** Offset along the base normal; null when the statement writes none. */
    offset: ValueExpr | null;
    rotateX: ValueExpr | null;
    rotateY: ValueExpr | null;
    rotateZ: ValueExpr | null;
    /** Normalized 0–1 position along the edge; null for the other forms. */
    position: ValueExpr | null;
  }
  | {
    feature: 'boolean';
    /** The statement's own callee — fuse, subtract or common. */
    kind: BooleanKind;
    /**
     * Target texts, verbatim, in argument order (a single-array form is
     * unpacked to its elements); empty operates on every active shape.
     */
    targetTexts: string[];
    /**
     * Per-target source location of the feature statement a plain-identifier
     * target references, or null when the expression doesn't resolve to one.
     * Same length as `targetTexts`; lets the edit dialog seed targets as
     * their timeline rows.
     */
    targetRefs: ({ line: number; column: number } | null)[];
  };

const EDITABLE_CALLEES: Record<string, EditableFeatureKind> = {
  extrude: 'extrude',
  cut: 'extrude',
  sweep: 'sweep',
  loft: 'loft',
  shell: 'shell',
  fillet: 'fillet',
  chamfer: 'chamfer',
  revolve: 'revolve',
  text: 'text',
  wrap: 'wrap',
  sketch: 'sketch',
  repeat: 'repeat',
  copy: 'copy',
  fuse: 'boolean',
  subtract: 'boolean',
  common: 'boolean',
  helix: 'helix',
  plane: 'plane',
};

/**
 * Chain members the dialogs edit, per feature. They must form a prefix of
 * the member chain: anything after the first unrecognized member (a chained
 * `.fillet()`, `.color()` …) is preserved verbatim, but a recognized member
 * hiding *behind* an unrecognized one would leave the dialog lying about the
 * statement, so that shape refuses to parse.
 */
const OPTION_MEMBERS: Record<EditableFeatureKind, Set<string>> = {
  extrude: new Set(['symmetric', 'draft', 'drill', 'thin', 'remove', 'new']),
  sweep: new Set(['thin', 'remove', 'new']),
  loft: new Set(['guides', 'startCondition', 'endCondition', 'thin', 'remove', 'new']),
  shell: new Set(['join']),
  fillet: new Set(),
  chamfer: new Set(),
  // `.symmetric()` is deliberately absent — symmetric revolve is broken in
  // the OC binding (SetRotation overload), so the dialog never writes it; a
  // trailing `.symmetric()` chain is preserved verbatim like any other.
  revolve: new Set(['thin', 'remove', 'new']),
  // Path-only chains (.offset/.flip/.startAt) are deliberately absent — the
  // dialog doesn't edit them, so they survive verbatim after the prefix.
  text: new Set(['font', 'size', 'weight', 'bold', 'italic', 'align', 'lineSpacing', 'letterSpacing']),
  // Wrap has no thin mode — only the boolean-operation chains.
  wrap: new Set(['remove', 'new']),
  // The dialog edits only the target argument; `.name()` and friends are
  // unrecognized members and survive verbatim after the root call.
  sketch: new Set(),
  // Everything the dialog edits lives in the root call's arguments; `.name()`
  // and friends are unrecognized members and survive verbatim.
  repeat: new Set(),
  // Like repeat: everything lives in the root call's arguments.
  copy: new Set(),
  // The targets are the root call's arguments; `.name()` and friends are
  // unrecognized members and survive verbatim.
  boolean: new Set(),
  // The single source is the root argument; every geometry option is a chained
  // configurator. A helix is a wire, so there is no boolean-operation chain.
  helix: new Set(['radius', 'endRadius', 'pitch', 'turns', 'height', 'startOffset', 'endOffset']),
  // The bases and the transform options are all root-call arguments; `.name()`
  // and friends are unrecognized members and survive verbatim.
  plane: new Set(),
};

type ChainSegment = { name: string; args: TSNode[]; endIndex: number };

/** Split a call chain into its root call and member calls, in source order. */
function decomposeChain(call: TSNode): { root: ChainSegment; members: ChainSegment[] } | null {
  const segments: ChainSegment[] = [];
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const argsNode = current.childForFieldName('arguments');
    const args = argsNode ? argsNode.namedChildren.filter(a => a.type !== 'comment') : [];
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      segments.push({ name: fn.text, args, endIndex: current.endIndex });
      segments.reverse();
      const [root, ...members] = segments;
      return { root, members };
    }
    if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (!prop) {
        return null;
      }
      segments.push({ name: prop.text, args, endIndex: current.endIndex });
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/** Numeric literal value of an argument node, or null when it is anything else. */
function numericArgValue(node: TSNode): number | null {
  const text = numericLiteralText(node);
  if (text === null) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read an argument slot that competes with profile/target expressions for
 * its position (extrude distances, the revolve angle): a numeric literal, a
 * variable known to hold a number, or arithmetic. Bare identifiers NOT known
 * to be numeric (profile variables) and call expressions (selector targets)
 * stay null so the positional disambiguation keeps working.
 */
function numericValueArg(node: TSNode, numericVars: Set<string>): ValueExpr | null {
  const literal = numericArgValue(node);
  if (literal !== null) {
    return literal;
  }
  if (node.type === 'identifier') {
    return numericVars.has(node.text) ? node.text : null;
  }
  if (node.type === 'binary_expression' || node.type === 'unary_expression'
    || node.type === 'parenthesized_expression') {
    return isExpressionText(node.text) ? node.text : null;
  }
  return null;
}

/**
 * Read an unambiguous numeric slot (draft, thin, wrap thickness, loft
 * magnitudes — nothing else can occupy the position): a numeric literal, or
 * any single-argument-safe expression text.
 */
function anyValueArg(node: TSNode): ValueExpr | null {
  const literal = numericArgValue(node);
  if (literal !== null) {
    return literal;
  }
  return isExpressionText(node.text) ? node.text : null;
}

/**
 * Which tab the helix edit dialog opens on, from the source text alone: a face
 * selector (a `face(...)` filter or a `.sideFaces()/.endFaces()/.faces()`
 * accessor) reads as 'face'; a standard-axis literal, an `axis(...)` call, or
 * an axis variable reads as 'axis'. A misread is one tab click to correct.
 */
function classifyHelixSource(text: string): 'axis' | 'face' {
  const t = text.trim();
  if (/\bface\s*\(/.test(t) || /\.(sideFaces|endFaces|faces)\s*\(/.test(t)) {
    return 'face';
  }
  return 'axis';
}

/**
 * Top-level variable names whose initializers read as numeric values —
 * literals, arithmetic (over earlier such variables), `param()` and `Math.*`
 * calls. Backs {@link numericValueArg}'s identifier disambiguation.
 */
function numericVarNames(tree: TSTree): Set<string> {
  const names = new Set<string>();
  const isNumericInit = (node: TSNode): boolean => {
    if (numericLiteralText(node) !== null) {
      return true;
    }
    if (node.type === 'binary_expression' || node.type === 'unary_expression'
      || node.type === 'parenthesized_expression') {
      return true;
    }
    if (node.type === 'identifier') {
      return names.has(node.text);
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (!fn) {
        return false;
      }
      if (fn.type === 'identifier' && fn.text === 'param') {
        return true;
      }
      return fn.type === 'member_expression' && fn.childForFieldName('object')?.text === 'Math';
    }
    return false;
  };
  for (const statement of tree.rootNode.namedChildren) {
    const decl = statement.type === 'export_statement'
      ? statement.namedChildren.find(c => c.type === 'lexical_declaration' || c.type === 'variable_declaration')
      : statement;
    if (!decl || (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration')) {
      continue;
    }
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (name?.type === 'identifier' && value && isNumericInit(value)) {
        names.add(name.text);
      }
    }
  }
  return names;
}

/** Boolean literal value of an argument node, or null when it is anything else. */
function booleanArgValue(node: TSNode): boolean | null {
  if (node.type === 'true') {
    return true;
  }
  if (node.type === 'false') {
    return false;
  }
  return null;
}

/**
 * The runtime value a plain string literal denotes — quotes dropped and JS
 * escape sequences decoded (the dialog edits the value, not the source
 * spelling). Null for anything but a single/double-quoted literal.
 */
function stringArgValue(node: TSNode): string | null {
  if (node.type !== 'string') {
    return null;
  }
  const raw = node.text;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return null;
  }
  const body = raw.slice(1, -1);
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, esc: string) => {
      switch (esc[0]) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return '\0';
        case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
        case 'u': {
          const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
          return String.fromCodePoint(parseInt(hex, 16));
        }
        default: return esc;
      }
    },
  );
}

/** `.weight('<name>')` values, mirroring the Text feature's own table. */
const TEXT_WEIGHT_NAMES: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400,
  normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700,
  extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/** Alignments the text dialog offers (start/end normalize onto them). */
const TEXT_DIALOG_ALIGNS = new Set(['left', 'center', 'right']);

type ChainParse =
  | { parsed: ParsedFeatureStatement; start: number; end: number }
  | { error: string };

/**
 * Read the feature chain rooted at `call` into its dialog-editable options.
 * `start`/`end` span the chain root through its last recognized option
 * member — the range an edit replaces; a `const x = ` binding before it and
 * unrecognized chained calls after it survive untouched.
 */
function parseFeatureChain(call: TSNode, code: string, numericVars: Set<string> = new Set()): ChainParse {
  const chain = decomposeChain(call);
  if (!chain) {
    return { error: 'the call at that line is not a plain feature call chain' };
  }
  const feature = EDITABLE_CALLEES[chain.root.name];
  if (!feature) {
    return { error: `${chain.root.name}() is not an editable feature statement` };
  }

  const options = OPTION_MEMBERS[feature];
  const recognized = new Map<string, ChainSegment>();
  let end = chain.root.endIndex;
  let stopped = false;
  for (const member of chain.members) {
    if (!stopped && options.has(member.name)) {
      if (recognized.has(member.name)) {
        return { error: `the statement chains .${member.name}() twice` };
      }
      recognized.set(member.name, member);
      end = member.endIndex;
      continue;
    }
    stopped = true;
    if (options.has(member.name)) {
      return { error: `a .${member.name}() chain follows other calls the dialog cannot edit — edit the statement in the source instead` };
    }
  }
  const start = call.startIndex;
  const args = chain.root.args;

  if (feature === 'shell' || feature === 'fillet' || feature === 'chamfer') {
    if (args.length === 0) {
      return { error: `the ${feature}() call has no arguments` };
    }
    // The value slot competes with the selector args — a numeric literal,
    // known numeric variable, or arithmetic reads as the value; a selector
    // expression there means the value was omitted, which has no dialog.
    const value = numericValueArg(args[0], numericVars);
    if (value === null) {
      return { error: `the ${feature}() ${feature === 'shell' ? 'thickness' : feature === 'fillet' ? 'radius' : 'distance'} is not a plain number or expression — edit it in the source` };
    }
    // Chamfer's second-value overloads: a numeric second argument reads as
    // the second distance, and a literal `true`/`false` after it as the
    // angle flag — everything past the value slots is the selector list.
    let distance2: ValueExpr | null = null;
    let isAngle = false;
    let selectorsFrom = 1;
    if (feature === 'chamfer' && args.length > 1) {
      const second = numericValueArg(args[1], numericVars);
      if (second !== null) {
        distance2 = second;
        selectorsFrom = 2;
        if (args.length > 2 && (args[2].type === 'true' || args[2].type === 'false')) {
          isAngle = args[2].type === 'true';
          selectorsFrom = 3;
        }
      }
    }
    const argsText = args.length > selectorsFrom
      ? code.slice(args[selectorsFrom].startIndex, args[args.length - 1].endIndex)
      : '';
    if (feature === 'shell') {
      const joinParse = parseJoinSegment(recognized.get('join'));
      if ('error' in joinParse) {
        return joinParse;
      }
      return { parsed: { feature, value, argsText, joinType: joinParse.joinType }, start, end };
    }
    if (feature === 'chamfer') {
      return { parsed: { feature, value, argsText, distance2, isAngle }, start, end };
    }
    return { parsed: { feature, value, argsText }, start, end };
  }

  if (feature === 'text') {
    return parseTextChain(args, recognized, start, end);
  }

  if (feature === 'sketch') {
    // sketch(() => {…}) / sketch(<target>, () => {…}): only the target
    // argument (a plane string, plane variable, or face selector) is
    // dialog-editable; the body callback is preserved verbatim.
    if (args.length < 1 || args.length > 2) {
      return { error: 'the sketch has an argument shape the dialog cannot edit' };
    }
    const body = args[args.length - 1];
    if (body.type !== 'arrow_function' && body.type !== 'function_expression'
      && body.type !== 'function' && body.type !== 'identifier') {
      return { error: 'the sketch body is not a function — edit it in the source' };
    }
    return {
      parsed: { feature, targetText: args.length === 2 ? args[0].text : null, bodyText: body.text },
      start,
      end,
    };
  }

  if (feature === 'repeat') {
    return parseRepeatChain(args, start, end, numericVars);
  }

  if (feature === 'copy') {
    return parseCopyChain(args, start, end);
  }

  if (feature === 'boolean') {
    return parseBooleanChain(chain.root.name as BooleanKind, args, start, end);
  }

  if (feature === 'plane') {
    return parsePlaneChain(args, start, end, numericVars);
  }

  const isCut = chain.root.name === 'cut';
  const hasRemove = recognized.has('remove');
  const hasNew = recognized.has('new');
  if ((isCut || hasRemove) && hasNew) {
    return { error: 'the statement chains both a remove and .new()' };
  }
  const op: 'add' | 'remove' | 'new' = isCut || hasRemove ? 'remove' : hasNew ? 'new' : 'add';

  let thin: [ValueExpr] | null = null;
  const thinSeg = recognized.get('thin');
  if (thinSeg) {
    if (thinSeg.args.length !== 1) {
      return { error: 'only a single-offset .thin() can be edited in the dialog' };
    }
    const offset = anyValueArg(thinSeg.args[0]);
    if (offset === null) {
      return { error: 'the .thin() offset is not a plain number or expression — edit it in the source' };
    }
    thin = [offset];
  }

  if (feature === 'extrude') {
    // Leading numeric values are distances — literals, known numeric
    // variables, or arithmetic; one, or two for the two-distance form
    // extrude(d1, d2); a single trailing non-numeric argument is the bound
    // profile expression, kept verbatim. A cut() with no distance is the
    // through-all remove. With NO distance, a leading string literal is a
    // first/last-face target and a call expression (`e.endFaces()`,
    // `select(…)`) is a picked-face target — two non-numeric arguments are
    // the target and the profile.
    const distances: ValueExpr[] = [];
    while (distances.length < Math.min(args.length, 2)) {
      const value = numericValueArg(args[distances.length], numericVars);
      if (value === null) {
        break;
      }
      distances.push(value);
    }
    const rest = args.slice(distances.length);
    const restLimit = distances.length === 0 ? 2 : 1;
    if (rest.length > restLimit || rest.some(arg => numericValueArg(arg, numericVars) !== null)) {
      return { error: 'the extrude has more arguments than the dialog understands' };
    }
    // The only string argument the call takes is a leading first/last-face
    // target; anywhere else it is not a form the dialog can read.
    const literalIndex = rest.findIndex(arg => arg.type === 'string');
    if (literalIndex > 0 || (literalIndex === 0 && distances.length > 0)) {
      return { error: 'the extrude has arguments the dialog does not understand' };
    }
    let toFaceText: string | null = null;
    let toFaceKind: ExtrudeTargetKind | null = null;
    let profileText: string | null = null;
    if (rest[0]?.type === 'string') {
      // extrude/cut('first-face' | 'last-face'[, <profile>]). The target may
      // carry face filters — call expressions the dialog cannot represent —
      // so a filtered target stays in the source.
      const literal = stringArgValue(rest[0]);
      if (literal !== 'first-face' && literal !== 'last-face') {
        return { error: `the ${chain.root.name}() target must be 'first-face' or 'last-face' — edit it in the source` };
      }
      if (rest[1]?.type === 'call_expression') {
        return { error: `a filtered '${literal}' ${chain.root.name}() target is not editable in the dialog — edit it in the source` };
      }
      toFaceText = rest[0].text;
      toFaceKind = literal;
      profileText = rest[1]?.text ?? null;
    } else if (distances.length === 0 && rest.length === 2) {
      // extrude(<face>, <profile>): unambiguous — a two-argument call with
      // no distance is the up-to-face form.
      toFaceText = rest[0].text;
      toFaceKind = 'selector';
      profileText = rest[1].text;
    } else if (distances.length === 0 && rest.length === 1 && rest[0].type === 'call_expression') {
      // A call expression can't be a bound profile variable — read it as
      // the up-to-face target (matches what the create dialog writes).
      toFaceText = rest[0].text;
      toFaceKind = 'selector';
    } else {
      profileText = rest.length === 1 ? rest[0].text : null;
    }
    const distance = distances[0] ?? null;
    const distance2 = distances[1] ?? null;
    if (distance === null && toFaceText === null && !isCut) {
      // extrude(x) is ambiguous between a variable distance and a bound
      // profile at the default distance — neither is dialog-editable.
      return {
        error: profileText !== null
          ? `the ${chain.root.name}() distance is not a plain number — edit it in the source`
          : 'an extrude with no distance is not editable in the dialog',
      };
    }

    const symmetricSeg = recognized.get('symmetric');
    if (symmetricSeg && symmetricSeg.args.length > 0) {
      return { error: 'the .symmetric() chain has arguments the dialog cannot edit' };
    }
    const symmetric = symmetricSeg !== undefined;
    if (symmetric && distance2 !== null) {
      return { error: `a two-distance ${chain.root.name}() cannot chain .symmetric() — edit it in the source` };
    }
    if (symmetric && toFaceText !== null) {
      return { error: `a to-face ${chain.root.name}() cannot chain .symmetric() — edit it in the source` };
    }

    let draft: ValueExpr | null = null;
    const draftSeg = recognized.get('draft');
    if (draftSeg) {
      if (draftSeg.args.length !== 1) {
        return { error: 'the .draft() chain has an argument shape the dialog cannot edit' };
      }
      draft = anyValueArg(draftSeg.args[0]);
      if (draft === null) {
        return { error: 'the .draft() angle is not a plain number or expression — edit it in the source' };
      }
    }

    let drill = true;
    const drillSeg = recognized.get('drill');
    if (drillSeg) {
      if (drillSeg.args.length > 1) {
        return { error: 'the .drill() chain has more arguments than the dialog understands' };
      }
      if (drillSeg.args.length === 1) {
        const value = booleanArgValue(drillSeg.args[0]);
        if (value === null) {
          return { error: 'the .drill() argument is not a plain boolean — edit it in the source' };
        }
        drill = value;
      }
      // A bare .drill() means true — the API default.
    }

    return {
      parsed: {
        feature, op, distance, distance2, symmetric, draft, drill, thin, profileText, toFaceText, toFaceKind,
      },
      start,
      end,
    };
  }

  if (feature === 'sweep') {
    if (args.length < 1 || args.length > 2) {
      return { error: 'the sweep has more arguments than the dialog understands' };
    }
    return {
      parsed: { feature, op, thin, pathText: args[0].text, profileText: args[1]?.text ?? null },
      start,
      end,
    };
  }

  if (feature === 'wrap') {
    // wrap(<thickness>, <sketch>, <face>): the thickness must be a plain
    // literal; the sketch and face expressions are kept verbatim.
    if (args.length !== 3) {
      return { error: 'the wrap has an argument shape the dialog cannot edit' };
    }
    const thickness = anyValueArg(args[0]);
    if (thickness === null) {
      return { error: 'the wrap() thickness is not a plain number or expression — edit it in the source' };
    }
    return {
      parsed: { feature, op, thickness, sketchText: args[1].text, faceText: args[2].text },
      start,
      end,
    };
  }

  if (feature === 'revolve') {
    // revolve(<axis>[, <angle>][, <profile>]): the axis is always first,
    // kept verbatim; a numeric-valued second argument is the angle (360 when
    // omitted) — a literal, known numeric variable, or arithmetic; a
    // trailing non-numeric argument is the bound profile expression, kept
    // verbatim — the create dialog's own shape. An unknown identifier is
    // indistinguishable from a profile, so it reads as one; the rule mirrors
    // extrude's distances.
    if (args.length < 1 || args.length > 3) {
      return { error: 'the revolve has more arguments than the dialog understands' };
    }
    const axisText = args[0].text;
    let angle: ValueExpr | null = null;
    let rest = args.slice(1);
    if (rest.length > 0) {
      const value = numericValueArg(rest[0], numericVars);
      if (value !== null) {
        angle = value;
        rest = rest.slice(1);
      }
    }
    if (rest.length > 1 || (rest.length === 1 && numericValueArg(rest[0], numericVars) !== null)) {
      return { error: 'the revolve has more arguments than the dialog understands' };
    }
    return {
      parsed: { feature, op, angle, thin, axisText, profileText: rest[0]?.text ?? null },
      start,
      end,
    };
  }

  if (feature === 'helix') {
    // helix(<source>): the single source argument (an axis literal/statement,
    // an axis(edge) call, or a face selector) is kept verbatim; every geometry
    // option is a chained configurator read as a plain number or expression.
    if (args.length !== 1) {
      return { error: 'the helix has an argument shape the dialog cannot edit' };
    }
    const sourceText = args[0].text;
    const option = (name: string): { value: ValueExpr | null } | { error: string } => {
      const seg = recognized.get(name);
      if (!seg) {
        return { value: null };
      }
      if (seg.args.length !== 1) {
        return { error: `the .${name}() chain has an argument shape the dialog cannot edit` };
      }
      const value = anyValueArg(seg.args[0]);
      if (value === null) {
        return { error: `the .${name}() value is not a plain number or expression — edit it in the source` };
      }
      return { value };
    };
    const radius = option('radius');
    if ('error' in radius) {
      return radius;
    }
    const endRadius = option('endRadius');
    if ('error' in endRadius) {
      return endRadius;
    }
    const pitch = option('pitch');
    if ('error' in pitch) {
      return pitch;
    }
    const turns = option('turns');
    if ('error' in turns) {
      return turns;
    }
    const height = option('height');
    if ('error' in height) {
      return height;
    }
    const startOffset = option('startOffset');
    if ('error' in startOffset) {
      return startOffset;
    }
    const endOffset = option('endOffset');
    if ('error' in endOffset) {
      return endOffset;
    }
    return {
      parsed: {
        feature,
        sourceText,
        sourceMode: classifyHelixSource(sourceText),
        radius: radius.value,
        endRadius: endRadius.value,
        pitch: pitch.value,
        turns: turns.value,
        height: height.value,
        startOffset: startOffset.value,
        endOffset: endOffset.value,
      },
      start,
      end,
    };
  }

  // Loft: every root argument is a profile expression, in order.
  if (args.length < 2) {
    return { error: 'the loft has fewer than two profiles' };
  }
  const guideSeg = recognized.get('guides');
  if (guideSeg && (guideSeg.args.length < 1 || guideSeg.args.length > 2)) {
    return { error: 'the .guides() chain must carry one or two guides' };
  }
  const startParse = parseConditionSegment(recognized.get('startCondition'));
  if ('error' in startParse) {
    return startParse;
  }
  const endParse = parseConditionSegment(recognized.get('endCondition'));
  if ('error' in endParse) {
    return endParse;
  }
  return {
    parsed: {
      feature: 'loft',
      op,
      thin,
      profileTexts: args.map(a => a.text),
      guideTexts: guideSeg ? guideSeg.args.map(a => a.text) : [],
      startCondition: startParse.condition,
      endCondition: endParse.condition,
    },
    start,
    end,
  };
}

/**
 * The recognized entries of a plain object-literal argument, keyed by
 * property name. Null when the node is not an object literal or carries a
 * shape the dialogs can't read back (spreads, shorthand, computed keys).
 */
function objectLiteralEntries(node: TSNode): Map<string, TSNode> | null {
  if (node.type !== 'object') {
    return null;
  }
  const entries = new Map<string, TSNode>();
  for (const child of node.namedChildren) {
    if (child.type === 'comment') {
      continue;
    }
    if (child.type !== 'pair') {
      return null;
    }
    const key = child.childForFieldName('key');
    const value = child.childForFieldName('value');
    if (!key || !value || (key.type !== 'property_identifier' && key.type !== 'string')) {
      return null;
    }
    const name = key.type === 'string' ? stringArgValue(key) : key.text;
    if (name === null) {
      return null;
    }
    entries.set(name, value);
  }
  return entries;
}

/**
 * Values of an option that may be a plain number/expression or an array of
 * them: `count: 3` reads as `[3]`, `count: [3, n]` as `[3, 'n']`. The slots
 * are unambiguous (object-literal properties), so any safe expression text
 * qualifies. Null when any element can't be read.
 */
function numericArrayValues(node: TSNode): ValueExpr[] | null {
  if (node.type === 'array') {
    const values: ValueExpr[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'comment') {
        continue;
      }
      const value = anyValueArg(child);
      if (value === null) {
        return null;
      }
      values.push(value);
    }
    return values;
  }
  const value = anyValueArg(node);
  return value === null ? null : [value];
}

/**
 * The call a plain identifier argument is bound to: a `const <name> = <call>`
 * declaration preceding the statement in a scope that encloses it. Null for
 * anything else (inline calls, unresolvable names, non-call initializers);
 * the nearest preceding declaration wins when a name is declared more than
 * once.
 */
function resolveIdentifierCall(node: TSNode, statementStart: number): TSNode | null {
  if (node.type !== 'identifier') {
    return null;
  }
  let root: TSNode = node;
  while (root.parent) {
    root = root.parent;
  }
  let best: TSNode | null = null;
  for (const candidate of walkTree(root)) {
    if (candidate.type !== 'variable_declarator' || candidate.startIndex >= statementStart) {
      continue;
    }
    const name = candidate.childForFieldName('name');
    const value = candidate.childForFieldName('value');
    if (!name || name.text !== node.text || !value || value.type !== 'call_expression') {
      continue;
    }
    const scope = enclosingScope(candidate);
    if (scope.startIndex > statementStart || scope.endIndex < statementStart) {
      continue;
    }
    if (!best || candidate.startIndex > best.startIndex) {
      best = candidate;
    }
  }
  return best?.childForFieldName('value') ?? null;
}

/**
 * Resolve a repeat/copy/plane input expression to the statement it
 * references. The returned location is the bound call's own start — the
 * source location its scene object reports — so the edit dialog can seed the
 * input as its timeline row.
 */
function resolveRepeatTargetRef(node: TSNode, statementStart: number): { line: number; column: number } | null {
  const call = resolveIdentifierCall(node, statementStart);
  return call ? { line: call.startPosition.row + 1, column: call.startPosition.column } : null;
}

/**
 * A `repeat('<kind>', …)` statement's dialog-editable reading. The kind must
 * be a plain string literal (the raw-matrix form has no dialog); axis, plane
 * and target expressions are preserved verbatim, numeric options must be
 * plain literals. A linear repeat reads its options object — count and
 * offset/length as scalars or matched-arity arrays (a scalar broadcasts
 * across the directions, the kernel's own rule) — and refuses options the
 * dialog doesn't offer (`skip`). A rotate's non-numeric third argument reads
 * as a target, like revolve's variable angle.
 */
function parseRepeatChain(
  args: TSNode[],
  start: number,
  end: number,
  numericVars: Set<string> = new Set(),
): ChainParse {
  const rawKind = args.length > 0 ? stringArgValue(args[0]) : null;
  if (rawKind === null) {
    return { error: 'a matrix repeat is not editable in the dialog — edit it in the source' };
  }
  if (rawKind !== 'linear' && rawKind !== 'circular' && rawKind !== 'mirror' && rawKind !== 'rotate') {
    return { error: `the repeat type '${rawKind}' is not one the dialog knows` };
  }
  const kind = rawKind as 'linear' | 'circular' | 'mirror' | 'rotate';
  const base = {
    feature: 'repeat' as const,
    kind,
    axisTexts: [] as string[],
    planeText: null as string | null,
    directions: null as { count: ValueExpr; value: ValueExpr }[] | null,
    spacingMode: null as 'offset' | 'length' | null,
    centered: false,
    count: null as ValueExpr | null,
    sweep: null as { mode: 'angle' | 'offset'; value: ValueExpr } | null,
    angle: null as ValueExpr | null,
    targetTexts: [] as string[],
    targetRefs: [] as ({ line: number; column: number } | null)[],
  };
  const targetFields = (nodes: TSNode[]) => ({
    targetTexts: nodes.map(n => n.text),
    targetRefs: nodes.map(n => resolveRepeatTargetRef(n, start)),
  });

  if (kind === 'mirror') {
    if (args.length < 2) {
      return { error: 'the repeat has fewer arguments than the dialog understands' };
    }
    return {
      parsed: { ...base, planeText: args[1].text, ...targetFields(args.slice(2)) },
      start,
      end,
    };
  }

  if (kind === 'rotate') {
    if (args.length < 2) {
      return { error: 'the repeat has fewer arguments than the dialog understands' };
    }
    // A numeric-valued third argument is the angle (90 when omitted) — a
    // literal, known numeric variable, or arithmetic; an unknown identifier
    // is indistinguishable from a target, so it reads as one — the revolve
    // variable-angle rule.
    let rest = args.slice(2);
    let angle: ValueExpr | null = null;
    if (rest.length > 0) {
      const value = numericValueArg(rest[0], numericVars);
      if (value !== null) {
        angle = value;
        rest = rest.slice(1);
      }
    }
    return {
      parsed: { ...base, axisTexts: [args[1].text], angle, ...targetFields(rest) },
      start,
      end,
    };
  }

  // Linear / circular: repeat('<kind>', <axis|[axes]>, {…}, …targets).
  if (args.length < 3) {
    return { error: 'the repeat has fewer arguments than the dialog understands' };
  }
  const axisNode = args[1];
  const axisTexts = axisNode.type === 'array'
    ? axisNode.namedChildren.filter(a => a.type !== 'comment').map(a => a.text)
    : [axisNode.text];
  const targets = targetFields(args.slice(3));
  const options = objectLiteralEntries(args[2]);
  if (options === null) {
    return { error: 'the repeat options are not a plain object literal — edit them in the source' };
  }

  if (kind === 'circular') {
    if (axisNode.type === 'array') {
      return { error: 'a circular repeat over several axes is not editable in the dialog — edit it in the source' };
    }
    for (const key of options.keys()) {
      if (key !== 'count' && key !== 'angle' && key !== 'offset') {
        return { error: `the repeat option '${key}' is not editable in the dialog — edit it in the source` };
      }
    }
    const countNode = options.get('count');
    const count = countNode ? anyValueArg(countNode) : null;
    if (count === null) {
      return { error: 'the repeat count is not a plain number or expression — edit it in the source' };
    }
    const angleNode = options.get('angle');
    const offsetNode = options.get('offset');
    if ((angleNode === undefined) === (offsetNode === undefined)) {
      return { error: 'a circular repeat takes exactly one of angle or offset — edit it in the source' };
    }
    const mode = angleNode !== undefined ? 'angle' as const : 'offset' as const;
    const value = anyValueArg(angleNode ?? offsetNode!);
    if (value === null) {
      return { error: `the repeat ${mode} is not a plain number or expression — edit it in the source` };
    }
    return {
      parsed: { ...base, axisTexts, count, sweep: { mode, value }, ...targets },
      start,
      end,
    };
  }

  // Linear: two directions is the dialog's ceiling (its own writing shape).
  if (axisTexts.length < 1 || axisTexts.length > 2) {
    return { error: 'a linear repeat over more than two directions is not editable in the dialog — edit it in the source' };
  }
  for (const key of options.keys()) {
    if (key !== 'count' && key !== 'offset' && key !== 'length' && key !== 'centered') {
      return { error: `the repeat option '${key}' is not editable in the dialog — edit it in the source` };
    }
  }
  const countNode = options.get('count');
  const counts = countNode ? numericArrayValues(countNode) : null;
  if (counts === null) {
    return { error: 'the repeat count is not a plain number — edit it in the source' };
  }
  const offsetNode = options.get('offset');
  const lengthNode = options.get('length');
  if ((offsetNode === undefined) === (lengthNode === undefined)) {
    return { error: 'a linear repeat takes exactly one of offset or length — edit it in the source' };
  }
  const spacingMode = offsetNode !== undefined ? 'offset' as const : 'length' as const;
  const values = numericArrayValues(offsetNode ?? lengthNode!);
  if (values === null) {
    return { error: `the repeat ${spacingMode} is not a plain number — edit it in the source` };
  }
  // A scalar (or single-element array) broadcasts across the directions —
  // the kernel's `counts[i] ?? counts[0]` rule; other arities would leave
  // the dialog lying about the statement.
  const arity = axisTexts.length;
  const broadcast = (list: ValueExpr[], label: string): ValueExpr[] | { error: string } => {
    if (list.length === arity) {
      return list;
    }
    if (list.length === 1) {
      return Array.from({ length: arity }, () => list[0]);
    }
    return { error: `the repeat ${label} entries do not match the directions — edit them in the source` };
  };
  const dirCounts = broadcast(counts, 'count');
  if ('error' in dirCounts) {
    return dirCounts;
  }
  const dirValues = broadcast(values, spacingMode);
  if ('error' in dirValues) {
    return dirValues;
  }
  let centered = false;
  const centeredNode = options.get('centered');
  if (centeredNode !== undefined) {
    const value = booleanArgValue(centeredNode);
    if (value === null) {
      return { error: 'the repeat centered flag is not a plain boolean — edit it in the source' };
    }
    centered = value;
  }
  return {
    parsed: {
      ...base,
      axisTexts,
      directions: dirCounts.map((count, i) => ({ count, value: dirValues[i] })),
      spacingMode,
      centered,
      ...targets,
    },
    start,
    end,
  };
}

/**
 * A `copy('<kind>', …)` statement's dialog-editable reading. The kind must be
 * a plain string literal, and only the 3D linear/circular forms have a dialog
 * — the 2D circular center-point form (an array second argument) refuses.
 * Axis and target expressions are preserved verbatim, numeric options must be
 * plain literals. A linear copy reads its options object — count and
 * offset/length as scalars or matched-arity arrays (a scalar broadcasts
 * across the directions, the kernel's own rule) — and refuses options the
 * dialog doesn't offer (`skip`, circular `centered`).
 */
function parseCopyChain(
  args: TSNode[],
  start: number,
  end: number,
): ChainParse {
  const rawKind = args.length > 0 ? stringArgValue(args[0]) : null;
  if (rawKind === null) {
    return { error: 'the copy kind is not a plain string literal — edit it in the source' };
  }
  if (rawKind !== 'linear' && rawKind !== 'circular') {
    return { error: `the copy type '${rawKind}' is not one the dialog knows` };
  }
  const kind = rawKind as 'linear' | 'circular';
  const base = {
    feature: 'copy' as const,
    kind,
    axisTexts: [] as string[],
    directions: null as { count: ValueExpr; value: ValueExpr }[] | null,
    spacingMode: null as 'offset' | 'length' | null,
    centered: false,
    count: null as ValueExpr | null,
    sweep: null as { mode: 'angle' | 'offset'; value: ValueExpr } | null,
    targetTexts: [] as string[],
    targetRefs: [] as ({ line: number; column: number } | null)[],
  };

  // Linear / circular: copy('<kind>', <axis|[axes]>, {…}, …targets).
  if (args.length < 3) {
    return { error: 'the copy has fewer arguments than the dialog understands' };
  }
  const axisNode = args[1];
  const axisTexts = axisNode.type === 'array'
    ? axisNode.namedChildren.filter(a => a.type !== 'comment').map(a => a.text)
    : [axisNode.text];
  const nodes = args.slice(3);
  const targets = {
    targetTexts: nodes.map(n => n.text),
    targetRefs: nodes.map(n => resolveRepeatTargetRef(n, start)),
  };
  const options = objectLiteralEntries(args[2]);
  if (options === null) {
    return { error: 'the copy options are not a plain object literal — edit them in the source' };
  }

  if (kind === 'circular') {
    if (axisNode.type === 'array') {
      return { error: 'a circular copy around a center point is not editable in the dialog — edit it in the source' };
    }
    for (const key of options.keys()) {
      if (key !== 'count' && key !== 'angle' && key !== 'offset') {
        return { error: `the copy option '${key}' is not editable in the dialog — edit it in the source` };
      }
    }
    const countNode = options.get('count');
    const count = countNode ? anyValueArg(countNode) : null;
    if (count === null) {
      return { error: 'the copy count is not a plain number or expression — edit it in the source' };
    }
    const angleNode = options.get('angle');
    const offsetNode = options.get('offset');
    if ((angleNode === undefined) === (offsetNode === undefined)) {
      return { error: 'a circular copy takes exactly one of angle or offset — edit it in the source' };
    }
    const mode = angleNode !== undefined ? 'angle' as const : 'offset' as const;
    const value = anyValueArg(angleNode ?? offsetNode!);
    if (value === null) {
      return { error: `the copy ${mode} is not a plain number or expression — edit it in the source` };
    }
    return {
      parsed: { ...base, axisTexts, count, sweep: { mode, value }, ...targets },
      start,
      end,
    };
  }

  // Linear: two directions is the dialog's ceiling (its own writing shape).
  if (axisTexts.length < 1 || axisTexts.length > 2) {
    return { error: 'a linear copy over more than two directions is not editable in the dialog — edit it in the source' };
  }
  for (const key of options.keys()) {
    if (key !== 'count' && key !== 'offset' && key !== 'length' && key !== 'centered') {
      return { error: `the copy option '${key}' is not editable in the dialog — edit it in the source` };
    }
  }
  const countNode = options.get('count');
  const counts = countNode ? numericArrayValues(countNode) : null;
  if (counts === null) {
    return { error: 'the copy count is not a plain number — edit it in the source' };
  }
  const offsetNode = options.get('offset');
  const lengthNode = options.get('length');
  if ((offsetNode === undefined) === (lengthNode === undefined)) {
    return { error: 'a linear copy takes exactly one of offset or length — edit it in the source' };
  }
  const spacingMode = offsetNode !== undefined ? 'offset' as const : 'length' as const;
  const values = numericArrayValues(offsetNode ?? lengthNode!);
  if (values === null) {
    return { error: `the copy ${spacingMode} is not a plain number — edit it in the source` };
  }
  // A scalar (or single-element array) broadcasts across the directions —
  // the kernel's `counts[i] ?? counts[0]` rule; other arities would leave
  // the dialog lying about the statement.
  const arity = axisTexts.length;
  const broadcast = (list: ValueExpr[], label: string): ValueExpr[] | { error: string } => {
    if (list.length === arity) {
      return list;
    }
    if (list.length === 1) {
      return Array.from({ length: arity }, () => list[0]);
    }
    return { error: `the copy ${label} entries do not match the directions — edit them in the source` };
  };
  const dirCounts = broadcast(counts, 'count');
  if ('error' in dirCounts) {
    return dirCounts;
  }
  const dirValues = broadcast(values, spacingMode);
  if ('error' in dirValues) {
    return dirValues;
  }
  let centered = false;
  const centeredNode = options.get('centered');
  if (centeredNode !== undefined) {
    const value = booleanArgValue(centeredNode);
    if (value === null) {
      return { error: 'the copy centered flag is not a plain boolean — edit it in the source' };
    }
    centered = value;
  }
  return {
    parsed: {
      ...base,
      axisTexts,
      directions: dirCounts.map((count, i) => ({ count, value: dirValues[i] })),
      spacingMode,
      centered,
      ...targets,
    },
    start,
    end,
  };
}

/**
 * A `fuse(…)`, `subtract(…)` or `common(…)` statement's dialog-editable
 * reading — the callee is the kind. Target expressions are preserved
 * verbatim; a single-array argument (`fuse([a, b])`) is unpacked to its
 * elements, so the edit rewrite flattens it. A subtract must carry exactly
 * its base and tool arguments; fuse and common accept any count (empty
 * operates on every active shape).
 */
function parseBooleanChain(
  kind: BooleanKind,
  args: TSNode[],
  start: number,
  end: number,
): ChainParse {
  let nodes = args;
  if (kind !== 'subtract' && args.length === 1 && args[0].type === 'array') {
    nodes = args[0].namedChildren.filter(a => a.type !== 'comment');
  }
  if (kind === 'subtract' && nodes.length !== 2) {
    return { error: 'a subtract takes exactly a base and a tool — edit it in the source' };
  }
  return {
    parsed: {
      feature: 'boolean',
      kind,
      targetTexts: nodes.map(n => n.text),
      targetRefs: nodes.map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/** The origin plane a base's string literal names, or null. */
function standardPlaneLiteral(node: TSNode): 'xy' | 'xz' | 'yz' | null {
  const value = stringArgValue(node);
  return value === 'xy' || value === 'xz' || value === 'yz' ? value : null;
}

/**
 * The named edge positions `plane(edge, 'middle')` accepts, as the
 * normalized positions they denote — the dialog edits a 0–1 number, so a
 * named form is read as its equivalent and rewritten numerically.
 */
const EDGE_POSITION_NAMES = new Map<string, number>([['start', 0], ['middle', 0.5], ['end', 1]]);

/** The transform-option members the plane dialog owns; the rest refuse. */
const PLANE_OPTION_MEMBERS = ['offset', 'rotateX', 'rotateY', 'rotateZ'] as const;

/**
 * Which form a plane base's text reads as (see {@link ParsedPlaneBase}). A
 * `plane(…)` call and an origin-plane literal are plane-likes; an edge filter
 * or accessor is an edge source, as is an identifier bound to a `helix(…)`;
 * every other identifier reads as a plane variable, and anything left is a
 * face selector. A misread costs one dropdown change to correct.
 */
function classifyPlaneBase(node: TSNode, boundCallee: string | null): ParsedPlaneBase['kind'] {
  if (node.type === 'identifier') {
    return boundCallee === 'helix' ? 'edge' : 'plane';
  }
  const text = node.text.trim();
  if (standardPlaneLiteral(node) !== null || /^plane\s*\(/.test(text)) {
    return 'plane';
  }
  return /\bedge\s*\(/.test(text) || /\.(sideEdges|endEdges|edges)\s*\(/.test(text) ? 'edge' : 'face';
}

/** Read one plane base argument into its dialog-editable reading. */
function readPlaneBase(node: TSNode, statementStart: number): ParsedPlaneBase {
  const call = resolveIdentifierCall(node, statementStart);
  return {
    text: node.text,
    kind: classifyPlaneBase(node, call ? chainRootCallee(call) : null),
    standard: standardPlaneLiteral(node),
    ref: call ? { line: call.startPosition.row + 1, column: call.startPosition.column } : null,
  };
}

/**
 * A `plane(…)` statement's dialog-editable reading. The bases are preserved
 * verbatim (and classified, so the dialog knows which form they fit); the
 * transform options must be a plain object literal of the four members the
 * dialog owns — anything else would be silently dropped by a rewrite, so it
 * refuses. The second argument disambiguates the forms: an options object or
 * nothing leaves an offset (or, with two bases, a mid) plane, a number is
 * the offset — or, on an edge base, the position along it — and a second
 * plane-like makes it a mid plane.
 */
function parsePlaneChain(
  args: TSNode[],
  start: number,
  end: number,
  numericVars: Set<string>,
): ChainParse {
  if (args.length === 0) {
    return { error: 'the plane() call has no arguments' };
  }
  if (args.length > 3) {
    return { error: 'the plane has more arguments than the dialog understands' };
  }
  const bases = [readPlaneBase(args[0], start)];
  let optionsNode: TSNode | null = null;
  /** The bare second argument: an offset, or an edge position. */
  let value: ValueExpr | null = null;
  /** A named edge position (`'middle'`) pins the form to the edge one. */
  let namedPosition = false;

  if (args.length > 1) {
    const second = args[1];
    const named = stringArgValue(second);
    const numeric = numericValueArg(second, numericVars);
    const position = named === null ? undefined : EDGE_POSITION_NAMES.get(named);
    if (second.type === 'object') {
      optionsNode = second;
    } else if (numeric !== null) {
      value = numeric;
    } else if (position !== undefined) {
      value = position;
      namedPosition = true;
    } else {
      bases.push(readPlaneBase(second, start));
    }
    if (args.length === 3) {
      if (bases.length !== 2 || args[2].type !== 'object') {
        return { error: 'the plane has an argument shape the dialog cannot edit' };
      }
      optionsNode = args[2];
    }
  }

  const type = bases.length === 2 ? 'mid' as const
    : namedPosition || (value !== null && bases[0].kind === 'edge') ? 'edge' as const
      : 'offset' as const;

  if (type === 'edge') {
    if (optionsNode) {
      return { error: 'an edge plane takes a position only — no transform options' };
    }
    return {
      parsed: {
        feature: 'plane', type, bases,
        offset: null, rotateX: null, rotateY: null, rotateZ: null, position: value,
      },
      start,
      end,
    };
  }

  const options = optionsNode ? objectLiteralEntries(optionsNode) : new Map<string, TSNode>();
  if (options === null) {
    return { error: 'the plane options are not a plain object literal — edit them in the source' };
  }
  const values: Record<(typeof PLANE_OPTION_MEMBERS)[number], ValueExpr | null> =
    { offset: value, rotateX: null, rotateY: null, rotateZ: null };
  for (const [name, node] of options) {
    const member = PLANE_OPTION_MEMBERS.find(m => m === name);
    if (!member) {
      return { error: `the plane options include ${name}, which the dialog cannot edit — edit the statement in the source` };
    }
    const read = anyValueArg(node);
    if (read === null) {
      return { error: `the plane ${name} is not a plain number or expression — edit it in the source` };
    }
    values[member] = read;
  }
  // The dialog offers an offset on the offset form only — its mid form has no
  // field to show one in, so a rewrite would silently drop it.
  if (type === 'mid' && values.offset !== null) {
    return { error: "the mid plane's offset is not one of the dialog's fields — edit the statement in the source" };
  }
  return {
    parsed: {
      feature: 'plane', type, bases,
      offset: values.offset, rotateX: values.rotateX, rotateY: values.rotateY, rotateZ: values.rotateZ,
      position: null,
    },
    start,
    end,
  };
}

/**
 * A `text("…"[, path])` statement's dialog-editable reading. The string must
 * be a plain literal (the dialog edits its value); a second argument — the
 * path the glyphs follow — is any expression, preserved verbatim. Option
 * members must be plain literals; alignment `start`/`end` normalize onto
 * `left`/`right`, the path-only distributed alignments refuse.
 */
function parseTextChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  start: number,
  end: number,
): ChainParse {
  if (args.length < 1 || args.length > 2) {
    return { error: 'the text has more arguments than the dialog understands' };
  }
  const text = stringArgValue(args[0]);
  if (text === null) {
    return { error: 'the text is not a plain string — edit it in the source' };
  }
  const pathText = args[1]?.text ?? null;

  let size = 10;
  const sizeSeg = recognized.get('size');
  if (sizeSeg) {
    const value = sizeSeg.args.length === 1 ? numericArgValue(sizeSeg.args[0]) : null;
    if (value === null || value <= 0) {
      return { error: 'the .size() value is not a plain positive number — edit it in the source' };
    }
    size = value;
  }

  let font: string | null = null;
  const fontSeg = recognized.get('font');
  if (fontSeg) {
    font = fontSeg.args.length === 1 ? stringArgValue(fontSeg.args[0]) : null;
    if (font === null) {
      return { error: 'the .font() name is not a plain string — edit it in the source' };
    }
  }

  const weightSeg = recognized.get('weight');
  const boldSeg = recognized.get('bold');
  if (weightSeg && boldSeg) {
    return { error: 'the statement chains both .weight() and .bold()' };
  }
  let weight = 400;
  if (boldSeg) {
    if (boldSeg.args.length > 0) {
      return { error: 'the .bold() chain has arguments the dialog cannot edit' };
    }
    weight = 700;
  } else if (weightSeg) {
    if (weightSeg.args.length !== 1) {
      return { error: 'the .weight() chain has an argument shape the dialog cannot edit' };
    }
    const numeric = numericArgValue(weightSeg.args[0]);
    const name = stringArgValue(weightSeg.args[0]);
    const value = numeric ?? (name !== null ? TEXT_WEIGHT_NAMES[name.toLowerCase()] ?? null : null);
    if (value === null || value % 100 !== 0 || value < 100 || value > 900) {
      return { error: 'the .weight() value is not one the dialog offers — edit it in the source' };
    }
    weight = value;
  }

  let italic = false;
  const italicSeg = recognized.get('italic');
  if (italicSeg) {
    if (italicSeg.args.length > 1) {
      return { error: 'the .italic() chain has more arguments than the dialog understands' };
    }
    if (italicSeg.args.length === 1) {
      const value = booleanArgValue(italicSeg.args[0]);
      if (value === null) {
        return { error: 'the .italic() argument is not a plain boolean — edit it in the source' };
      }
      italic = value;
    } else {
      italic = true;
    }
  }

  let align: 'left' | 'center' | 'right' = 'left';
  const alignSeg = recognized.get('align');
  if (alignSeg) {
    const raw = alignSeg.args.length === 1 ? stringArgValue(alignSeg.args[0]) : null;
    const normalized = raw === 'start' ? 'left' : raw === 'end' ? 'right' : raw;
    if (normalized === null || !TEXT_DIALOG_ALIGNS.has(normalized)) {
      return { error: `the .align() value is not one the dialog offers — edit it in the source` };
    }
    align = normalized as 'left' | 'center' | 'right';
  }

  let lineSpacing = 1;
  const lineSeg = recognized.get('lineSpacing');
  if (lineSeg) {
    const value = lineSeg.args.length === 1 ? numericArgValue(lineSeg.args[0]) : null;
    if (value === null || value <= 0) {
      return { error: 'the .lineSpacing() value is not a plain positive number — edit it in the source' };
    }
    lineSpacing = value;
  }

  let letterSpacing = 0;
  const letterSeg = recognized.get('letterSpacing');
  if (letterSeg) {
    const value = letterSeg.args.length === 1 ? numericArgValue(letterSeg.args[0]) : null;
    if (value === null) {
      return { error: 'the .letterSpacing() value is not a plain number — edit it in the source' };
    }
    letterSpacing = value;
  }

  return {
    parsed: {
      feature: 'text', text, size, font, weight, italic, align, lineSpacing, letterSpacing, pathText,
    },
    start,
    end,
  };
}

const SHELL_JOIN_KINDS = new Set<ShellJoinKind>(['arc', 'intersection', 'tangent']);

/**
 * A shell's `.join(…)` member: a plain 'arc' / 'intersection' / 'tangent'
 * string. Absence reads as 'arc' — the kernel default.
 */
function parseJoinSegment(
  seg: ChainSegment | undefined,
): { joinType: ShellJoinKind } | { error: string } {
  if (!seg) {
    return { joinType: 'arc' };
  }
  const typeNode = seg.args.length === 1 ? seg.args[0] : null;
  if (!typeNode || typeNode.type !== 'string') {
    return { error: 'the .join() type is not a plain string — edit it in the source' };
  }
  const type = typeNode.text.slice(1, -1) as ShellJoinKind;
  if (!SHELL_JOIN_KINDS.has(type)) {
    return { error: `the .join() type '${type}' is not one the dialog knows` };
  }
  return { joinType: type };
}

/**
 * One `.startCondition(…)`/`.endCondition(…)` member: a plain 'normal' /
 * 'tangent' string plus an optional numeric magnitude (default 1). A 'none'
 * argument reads as no condition — the API's 'none' merely clears one.
 */
function parseConditionSegment(
  seg: ChainSegment | undefined,
): { condition: LoftConditionSpec | null } | { error: string } {
  if (!seg) {
    return { condition: null };
  }
  if (seg.args.length < 1 || seg.args.length > 2) {
    return { error: `the .${seg.name}() chain has an argument shape the dialog cannot edit` };
  }
  const typeNode = seg.args[0];
  if (typeNode.type !== 'string') {
    return { error: `the .${seg.name}() type is not a plain string — edit it in the source` };
  }
  const type = typeNode.text.slice(1, -1);
  if (type === 'none') {
    return { condition: null };
  }
  if (type !== 'normal' && type !== 'tangent') {
    return { error: `the .${seg.name}() type '${type}' is not one the dialog knows` };
  }
  let magnitude: ValueExpr = 1;
  if (seg.args.length === 2) {
    const parsed = anyValueArg(seg.args[1]);
    if (parsed === null || parsed === 0) {
      return { error: `the .${seg.name}() magnitude is not a plain nonzero number or expression — edit it in the source` };
    }
    magnitude = parsed;
  }
  return { condition: { type, magnitude } };
}

/**
 * Read the feature statement at `line` of `code` into its dialog-editable
 * options — the read half of the double-click → edit-dialog round trip.
 * `statement` is the chain text the dialog would rewrite, for display.
 */
export async function parseFeatureStatement(
  code: string,
  line: number,
): Promise<{ ok: true; parsed: ParsedFeatureStatement; statement: string } | { ok: false; reason: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, line);
  if (!call) {
    return { ok: false, reason: `no call found at line ${line} — is the file in sync with the last render?` };
  }
  const chain = parseFeatureChain(call, code, numericVarNames(tree));
  if ('error' in chain) {
    return { ok: false, reason: chain.error };
  }
  return { ok: true, parsed: chain.parsed, statement: code.slice(chain.start, chain.end) };
}

function validEditOp(op: unknown): op is 'add' | 'remove' | 'new' {
  return op === 'add' || op === 'remove' || op === 'new';
}

function validEditThin(thin: unknown): thin is [ValueExpr] | [ValueExpr, ValueExpr] | null {
  if (thin === null) {
    return true;
  }
  return Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every(t => validValueExpr(t, { positive: true }));
}

function validEditCondition(condition: LoftConditionSpec | undefined): boolean {
  return condition === undefined
    || ((condition.type === 'normal' || condition.type === 'tangent')
      && validValueExpr(condition.magnitude, { nonzero: true }));
}

function validNonzeroOrNull(value: unknown): value is ValueExpr | null {
  return value === null || validValueExpr(value, { nonzero: true });
}

/** A nullable ValueExpr slot: null (the option is omitted) or a valid value. */
function validValueExprOrNull(
  value: unknown,
  opts: { nonzero?: boolean; positive?: boolean } = {},
): value is ValueExpr | null {
  return value === null || validValueExpr(value, opts);
}

/** The spec fields `renderEditedStatement` reads. */
type EditRenderSpec = Pick<ApplyFeatureEditSpec, 'feature' | 'value' | 'rawArgs' | 'edit' | 'producers' | 'parts'>;

/**
 * Variable text of a re-sourced sketch/wire slot: the binding's name, else
 * the hint. The route types each slot's producer ('sketch' for profiles,
 * 'wire' for paths/guides), so accepting both here stays sound — the callee
 * check happens where the producer binds.
 */
function editSourceVar(
  spec: EditRenderSpec,
  producer: number,
  varFor: (producer: number) => string | null,
): string | { error: string } {
  if (!isWireProducer(spec as ApplyFeatureEditSpec, producer)) {
    return { error: 'malformed edit spec: a re-sourced slot references a non-sketch producer' };
  }
  return varFor(producer) ?? spec.producers[producer].nameHint ?? 's';
}

/**
 * Resolve an edited loft's profile/guide expressions: `verbatim` entries
 * re-read the statement's own argument texts by position, re-picked entries
 * render from producers/parts. Selector parts must be covered exactly once
 * across the profiles — never dropped, never duplicated.
 */
function resolveLoftSources(
  parsed: Extract<ParsedFeatureStatement, { feature: 'loft' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { profileExprs: string[]; guideExprs: string[] } | { error: string } {
  const opts = spec.edit!.loft!;

  let profileExprs = parsed.profileTexts;
  if (opts.profiles !== undefined) {
    if (!Array.isArray(opts.profiles) || opts.profiles.length < 2) {
      return { error: 'a loft needs at least two profiles' };
    }
    const usedVerbatim = new Set<number>();
    const usedParts = new Set<number>();
    const exprs: string[] = [];
    for (const profile of opts.profiles) {
      if (profile?.kind === 'verbatim') {
        if (!Number.isInteger(profile.sourceIndex) || profile.sourceIndex < 0
          || profile.sourceIndex >= parsed.profileTexts.length || usedVerbatim.has(profile.sourceIndex)) {
          return { error: 'malformed loft edit spec: a kept profile no longer matches the statement' };
        }
        usedVerbatim.add(profile.sourceIndex);
        exprs.push(parsed.profileTexts[profile.sourceIndex]);
      } else if (profile?.kind === 'sketch') {
        const varName = editSourceVar(spec, profile.producer, varFor);
        if (typeof varName !== 'string') {
          return varName;
        }
        exprs.push(varName);
      } else if (profile?.kind === 'selector') {
        if (!Number.isInteger(profile.part) || profile.part < 0
          || profile.part >= spec.parts.length || usedParts.has(profile.part)) {
          return { error: 'malformed loft edit spec: bad selector profile' };
        }
        usedParts.add(profile.part);
        const part = spec.parts[profile.part];
        exprs.push(renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer)));
      } else {
        return { error: 'malformed loft edit spec: unknown profile kind' };
      }
    }
    if (usedParts.size !== spec.parts.length) {
      return { error: 'malformed loft edit spec: a selector part belongs to no profile' };
    }
    profileExprs = exprs;
  } else if (spec.parts.length > 0) {
    return { error: 'malformed loft edit spec: selector parts without a profile list' };
  }

  let guideExprs = parsed.guideTexts;
  if (opts.guides !== undefined) {
    if (!Array.isArray(opts.guides) || opts.guides.length > 2) {
      return { error: 'a loft takes at most two guides' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const guide of opts.guides) {
      if (guide?.kind === 'verbatim') {
        if (!Number.isInteger(guide.sourceIndex) || guide.sourceIndex < 0
          || guide.sourceIndex >= parsed.guideTexts.length || usedVerbatim.has(guide.sourceIndex)) {
          return { error: 'malformed loft edit spec: a kept guide no longer matches the statement' };
        }
        usedVerbatim.add(guide.sourceIndex);
        exprs.push(parsed.guideTexts[guide.sourceIndex]);
      } else if (guide?.kind === 'sketch') {
        const varName = editSourceVar(spec, guide.producer, varFor);
        if (typeof varName !== 'string') {
          return varName;
        }
        exprs.push(varName);
      } else {
        return { error: 'malformed loft edit spec: unknown guide kind' };
      }
    }
    guideExprs = exprs;
  }

  return { profileExprs, guideExprs };
}

/**
 * Render an edited repeat statement: resolve each axis/plane input — keep
 * entries re-read the statement's own argument texts by position, re-sourced
 * entries render from producers/parts like create mode — and the target list
 * (`verbatim` keeps by position, re-picked features by bound producer; an
 * absent list keeps every statement target). Selector parts must be covered
 * exactly once across the inputs — never dropped, never duplicated.
 */
function renderEditedRepeat(
  parsed: Extract<ParsedFeatureStatement, { feature: 'repeat' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.repeat;
  if (!opts || (opts.kind !== 'linear' && opts.kind !== 'circular'
    && opts.kind !== 'mirror' && opts.kind !== 'rotate')) {
    return { error: 'malformed repeat edit spec' };
  }
  const usedParts = new Set<number>();
  const claimPart = (part: number): boolean => {
    if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length || usedParts.has(part)) {
      return false;
    }
    usedParts.add(part);
    return true;
  };
  const resolveAxis = (axis: RepeatEditAxis | undefined): string | { error: string } => {
    if (axis?.kind === 'keep') {
      const text = Number.isInteger(axis.sourceIndex) ? parsed.axisTexts[axis.sourceIndex] : undefined;
      if (text === undefined) {
        return { error: 'malformed repeat edit spec: a kept axis no longer matches the statement' };
      }
      return text;
    }
    if (axis?.kind === 'selector') {
      if (!claimPart(axis.part)) {
        return { error: 'malformed repeat edit spec: bad selector axis' };
      }
    } else if (axis?.kind === 'axis') {
      if (!isAxisProducer(spec as ApplyFeatureEditSpec, axis.producer)) {
        return { error: 'malformed repeat edit spec: the axis references a non-axis producer' };
      }
    } else if (axis?.kind !== 'standard'
      || (axis.axis !== 'x' && axis.axis !== 'y' && axis.axis !== 'z')) {
      return { error: 'malformed repeat edit spec' };
    }
    return renderRepeatAxisExpr(axis, spec.parts, varFor);
  };

  let inputExprs: string[];
  let directions: { count: ValueExpr; value: ValueExpr }[] | undefined;
  if (opts.kind === 'linear') {
    if (!Array.isArray(opts.directions) || opts.directions.length < 1
      || (opts.spacingMode !== 'offset' && opts.spacingMode !== 'length')
      || !opts.directions.every(d => validCountValue(d?.count)
        && validValueExpr(d.value, { nonzero: true }))) {
      return { error: 'malformed repeat edit spec' };
    }
    inputExprs = [];
    for (const direction of opts.directions) {
      const expr = resolveAxis(direction.axis);
      if (typeof expr !== 'string') {
        return expr;
      }
      inputExprs.push(expr);
    }
    directions = opts.directions.map(d => ({ count: d.count, value: d.value }));
  } else if (opts.kind === 'mirror') {
    const plane = opts.plane;
    let planeExpr: string;
    if (plane?.kind === 'keep') {
      if (parsed.planeText === null) {
        return { error: 'malformed repeat edit spec: a kept plane no longer matches the statement' };
      }
      planeExpr = parsed.planeText;
    } else {
      if (plane?.kind === 'selector') {
        if (!claimPart(plane.part)) {
          return { error: 'malformed repeat edit spec: bad selector plane' };
        }
      } else if (plane?.kind === 'plane') {
        if (!isPlaneProducer(spec as ApplyFeatureEditSpec, plane.producer)) {
          return { error: 'malformed repeat edit spec: the plane references a non-plane producer' };
        }
      } else if (plane?.kind !== 'standard'
        || (plane.plane !== 'xy' && plane.plane !== 'xz' && plane.plane !== 'yz')) {
        return { error: 'malformed repeat edit spec' };
      }
      planeExpr = renderRepeatPlaneExpr(plane, spec.parts, varFor);
    }
    inputExprs = [planeExpr];
  } else {
    if (opts.kind === 'circular') {
      if (!validCountValue(opts.count)
        || opts.sweep === undefined
        || (opts.sweep.mode !== 'angle' && opts.sweep.mode !== 'offset')
        || !validValueExpr(opts.sweep.value, { nonzero: true })) {
        return { error: 'malformed repeat edit spec' };
      }
    } else if (!validValueExpr(opts.angle, { nonzero: true })) {
      return { error: 'malformed repeat edit spec' };
    }
    const expr = resolveAxis(opts.axis);
    if (typeof expr !== 'string') {
      return expr;
    }
    inputExprs = [expr];
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a repeat needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed repeat edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed repeat edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed repeat edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed repeat edit spec: a selector part belongs to no input' };
  }

  return {
    statement: renderRepeatStatement(
      {
        kind: opts.kind,
        directions,
        spacingMode: opts.spacingMode,
        centered: opts.centered,
        count: opts.count,
        sweep: opts.sweep,
        angle: opts.angle,
      },
      inputExprs,
      targetExprs,
    ),
  };
}

/**
 * Render an edited copy statement: resolve each axis input — keep entries
 * re-read the statement's own argument texts by position, re-sourced entries
 * render from producers/parts like create mode — and the target list
 * (`verbatim` keeps by position, re-picked features by bound producer; an
 * absent list keeps every statement target). Selector parts must be covered
 * exactly once across the inputs — never dropped, never duplicated.
 */
function renderEditedCopy(
  parsed: Extract<ParsedFeatureStatement, { feature: 'copy' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.copy;
  if (!opts || (opts.kind !== 'linear' && opts.kind !== 'circular')) {
    return { error: 'malformed copy edit spec' };
  }
  const usedParts = new Set<number>();
  const claimPart = (part: number): boolean => {
    if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length || usedParts.has(part)) {
      return false;
    }
    usedParts.add(part);
    return true;
  };
  const resolveAxis = (axis: RepeatEditAxis | undefined): string | { error: string } => {
    if (axis?.kind === 'keep') {
      const text = Number.isInteger(axis.sourceIndex) ? parsed.axisTexts[axis.sourceIndex] : undefined;
      if (text === undefined) {
        return { error: 'malformed copy edit spec: a kept axis no longer matches the statement' };
      }
      return text;
    }
    if (axis?.kind === 'selector') {
      if (!claimPart(axis.part)) {
        return { error: 'malformed copy edit spec: bad selector axis' };
      }
    } else if (axis?.kind === 'axis') {
      if (!isAxisProducer(spec as ApplyFeatureEditSpec, axis.producer)) {
        return { error: 'malformed copy edit spec: the axis references a non-axis producer' };
      }
    } else if (axis?.kind !== 'standard'
      || (axis.axis !== 'x' && axis.axis !== 'y' && axis.axis !== 'z')) {
      return { error: 'malformed copy edit spec' };
    }
    return renderRepeatAxisExpr(axis, spec.parts, varFor);
  };

  let inputExprs: string[];
  let directions: { count: ValueExpr; value: ValueExpr }[] | undefined;
  if (opts.kind === 'linear') {
    if (!Array.isArray(opts.directions) || opts.directions.length < 1
      || (opts.spacingMode !== 'offset' && opts.spacingMode !== 'length')
      || !opts.directions.every(d => validCountValue(d?.count)
        && validValueExpr(d.value, { nonzero: true }))) {
      return { error: 'malformed copy edit spec' };
    }
    inputExprs = [];
    for (const direction of opts.directions) {
      const expr = resolveAxis(direction.axis);
      if (typeof expr !== 'string') {
        return expr;
      }
      inputExprs.push(expr);
    }
    directions = opts.directions.map(d => ({ count: d.count, value: d.value }));
  } else {
    if (!validCountValue(opts.count)
      || opts.sweep === undefined
      || (opts.sweep.mode !== 'angle' && opts.sweep.mode !== 'offset')
      || !validValueExpr(opts.sweep.value, { nonzero: true })) {
      return { error: 'malformed copy edit spec' };
    }
    const expr = resolveAxis(opts.axis);
    if (typeof expr !== 'string') {
      return expr;
    }
    inputExprs = [expr];
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a copy needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed copy edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed copy edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed copy edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed copy edit spec: a selector part belongs to no input' };
  }

  return {
    statement: renderCopyStatement(
      {
        kind: opts.kind,
        directions,
        spacingMode: opts.spacingMode,
        centered: opts.centered,
        count: opts.count,
        sweep: opts.sweep,
      },
      inputExprs,
      targetExprs,
    ),
  };
}

/**
 * Render an edited boolean statement: the kind picks the callee (an edit may
 * rewrite a fuse into a subtract), and the target list mixes `verbatim`
 * keeps (re-read from the statement's own argument texts by position) with
 * re-picked feature statements by bound producer; an absent list keeps
 * every statement target. A subtract must end up with exactly its base and
 * tool, in argument order.
 */
function renderEditedBoolean(
  parsed: Extract<ParsedFeatureStatement, { feature: 'boolean' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.boolean;
  if (!opts || (opts.kind !== 'fuse' && opts.kind !== 'subtract' && opts.kind !== 'common')) {
    return { error: 'malformed boolean edit spec' };
  }
  if (spec.parts.length !== 0) {
    return { error: 'malformed boolean edit spec: a boolean renders no selector parts' };
  }
  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a boolean needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed boolean edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed boolean edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed boolean edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (opts.kind === 'subtract' && targetExprs.length !== 2) {
    return { error: 'a subtract takes exactly a base and a tool solid' };
  }
  return { statement: renderBooleanStatement(opts.kind, targetExprs) };
}

/**
 * Render an edited plane statement: the type and the numeric options come
 * from the dialog wholesale, while the base list mixes `verbatim` keeps
 * (re-read from the statement's own base texts by position, lifted into
 * `plane(…)` when a mid plane needs a plane-like out of a raw selector) with
 * re-picked bases by part or bound producer; an absent list keeps every
 * statement base. The form's own rules — arity, the edge plane's position and
 * edge source — hold for the statement being WRITTEN, whatever the parsed
 * one was.
 */
function renderEditedPlane(
  parsed: Extract<ParsedFeatureStatement, { feature: 'plane' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.plane;
  if (!opts || (opts.type !== 'offset' && opts.type !== 'mid' && opts.type !== 'edge')
    || ![opts.offset, opts.rotateX, opts.rotateY, opts.rotateZ].every(v => v === null || validValueExpr(v))) {
    return { error: 'malformed plane edit spec' };
  }
  if (opts.type === 'edge') {
    if (opts.position === null || opts.position === undefined || !validValueExpr(opts.position)
      || (typeof opts.position === 'number' && (opts.position < 0 || opts.position > 1))) {
      return { error: 'an edge plane takes a position between 0 (start) and 1 (end)' };
    }
    if ([opts.offset, opts.rotateX, opts.rotateY, opts.rotateZ].some(v => v !== null)) {
      return { error: 'an edge plane takes a position only — no offset or rotation' };
    }
  } else if (opts.position !== null && opts.position !== undefined) {
    return { error: 'a position is only valid for an edge plane' };
  }

  const bases: PlaneEditBase[] = opts.bases
    ?? parsed.bases.map((_, sourceIndex) => ({ kind: 'verbatim' as const, sourceIndex }));
  const arity = opts.type === 'mid' ? 2 : 1;
  if (!Array.isArray(bases) || bases.length !== arity) {
    return {
      error: opts.type === 'mid'
        ? 'a mid plane takes exactly two bases'
        : `an ${opts.type} plane takes exactly one base`,
    };
  }
  const usedVerbatim = new Set<number>();
  const usedParts = new Set<number>();
  const exprs: string[] = [];
  for (const base of bases) {
    if (base?.kind === 'verbatim') {
      const kept = parsed.bases[base.sourceIndex];
      if (!Number.isInteger(base.sourceIndex) || !kept || usedVerbatim.has(base.sourceIndex)) {
        return { error: 'malformed plane edit spec: a kept base no longer matches the statement' };
      }
      usedVerbatim.add(base.sourceIndex);
      // A mid plane's arguments must be plane-like — a kept face/edge
      // selector is lifted exactly like a re-picked one.
      exprs.push(opts.type === 'mid' && kept.kind !== 'plane' ? `plane(${kept.text})` : kept.text);
      continue;
    }
    if (base?.kind === 'standard') {
      if (base.plane !== 'xy' && base.plane !== 'xz' && base.plane !== 'yz') {
        return { error: 'malformed plane edit spec: bad standard plane' };
      }
    } else if (base?.kind === 'plane') {
      if (!isPlaneProducer(spec as ApplyFeatureEditSpec, base.producer)) {
        return { error: 'malformed plane edit spec: a base references a non-plane producer' };
      }
    } else if (base?.kind === 'wire') {
      if (!isWireProducer(spec as ApplyFeatureEditSpec, base.producer)) {
        return { error: 'malformed plane edit spec: a base references a non-wire producer' };
      }
    } else if (base?.kind === 'selector') {
      if (!Number.isInteger(base.part) || base.part < 0 || base.part >= spec.parts.length
        || usedParts.has(base.part)) {
        return { error: 'malformed plane edit spec: a re-picked base no longer matches its selection' };
      }
      usedParts.add(base.part);
    } else {
      return { error: 'malformed plane edit spec: unknown base kind' };
    }
    exprs.push(renderPlaneBaseExpr(base, opts.type, spec.parts, varFor));
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed plane edit spec: a selector part belongs to no base' };
  }
  // The edge form reads its base as an edge: a re-picked one, a helix, or the
  // statement's own edge argument kept in place.
  if (opts.type === 'edge') {
    const source = bases[0];
    const isEdgeSource = source?.kind === 'selector' || source?.kind === 'wire'
      || (source?.kind === 'verbatim' && parsed.bases[source.sourceIndex].kind === 'edge');
    if (!isEdgeSource) {
      return { error: 'an edge plane takes a picked edge or a helix as its base' };
    }
  }
  return { statement: renderPlaneStatement(opts, exprs) };
}

/**
 * Render the statement `spec`'s dialog options produce over the parsed
 * statement, keeping the expressions the dialog doesn't edit verbatim.
 * Re-sourced slots (a re-picked profile/path/selection) render from
 * `producers`/`parts` through `varFor` — the transform passes its bindings'
 * names, the route's preview passes its namer's, so both emit identical
 * text. Shared with the route's preview so the previewed text is exactly
 * what the transform writes.
 */
export function renderEditedStatement(
  parsed: ParsedFeatureStatement,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null = () => null,
): { statement: string } | { error: string } {
  if (spec.feature !== parsed.feature) {
    return {
      error: `the statement is a ${parsed.feature}, not a ${spec.feature} — `
        + 'is the file in sync with the last render?',
    };
  }
  if (parsed.feature === 'extrude') {
    const opts = spec.edit?.extrude;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validNonzeroOrNull(opts.distance2) || !validNonzeroOrNull(opts.draft)
      || typeof opts.symmetric !== 'boolean' || typeof opts.drill !== 'boolean') {
      return { error: 'malformed extrude edit spec' };
    }
    let faceExpr: string | null = null;
    let target: ExtrudeTargetKind | undefined;
    if (opts.toFace !== undefined) {
      if (opts.distance !== null || opts.distance2 !== null || opts.symmetric) {
        return { error: 'a to-face extrude takes no distance and cannot be symmetric' };
      }
      if (opts.toFace.kind === 'keep') {
        if (parsed.toFaceText === null) {
          return { error: 'the statement has no to-face target to keep — pick a face' };
        }
        faceExpr = parsed.toFaceText;
        target = parsed.toFaceKind ?? 'selector';
      } else if (opts.toFace.kind === 'selector') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed extrude edit spec: a re-picked target is exactly one part' };
        }
        const part = spec.parts[0];
        faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
        target = 'selector';
      } else if (opts.toFace.kind === 'first-face' || opts.toFace.kind === 'last-face') {
        if (spec.parts.length > 0) {
          return { error: 'malformed extrude edit spec: a first/last-face target takes no selector parts' };
        }
        faceExpr = renderFaceTargetExpr(opts.toFace.kind);
        target = opts.toFace.kind;
      } else {
        return { error: 'malformed extrude edit spec: unknown to-face target' };
      }
    } else {
      if (spec.parts.length > 0) {
        return { error: 'malformed extrude edit spec: selector parts without a to-face target' };
      }
      if (opts.distance === null) {
        if (opts.op !== 'remove') {
          return { error: 'distance may be null (through-all) only for a remove' };
        }
        if (opts.distance2 !== null) {
          return { error: 'a two-distance extrude cannot be through-all' };
        }
      } else if (!validValueExpr(opts.distance, { nonzero: true })) {
        return { error: 'malformed extrude edit spec' };
      }
      if (opts.distance2 !== null && opts.symmetric) {
        return { error: 'a two-distance extrude cannot be symmetric' };
      }
    }
    let profileText = parsed.profileText;
    if (opts.profile !== undefined && opts.profile.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.profile.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      profileText = varName;
    }
    const { toFace, ...rest } = opts;
    return {
      statement: renderExtrudeStatement(
        { ...rest, profile: profileText ? 'bound' : 'implicit', toFace: target },
        profileText,
        faceExpr,
      ),
    };
  }
  if (parsed.feature === 'sweep') {
    const opts = spec.edit?.sweep;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)) {
      return { error: 'malformed sweep edit spec' };
    }
    let pathText = parsed.pathText;
    if (opts.path !== undefined && opts.path.kind !== 'keep') {
      if (opts.path.kind === 'selector') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed sweep edit spec: a selector path is exactly one part' };
        }
        const part = spec.parts[0];
        pathText = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
      } else {
        const varName = editSourceVar(spec, opts.path.producer, varFor);
        if (typeof varName !== 'string') {
          return varName;
        }
        pathText = varName;
      }
    } else if (spec.parts.length > 0) {
      return { error: 'malformed sweep edit spec: selector parts without a re-sourced path' };
    }
    let profileText = parsed.profileText;
    if (opts.profile !== undefined && opts.profile.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.profile.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      profileText = varName;
    }
    return {
      statement: renderSweepStatement({ op: opts.op, thin: opts.thin }, pathText, profileText),
    };
  }
  if (parsed.feature === 'wrap') {
    const opts = spec.edit?.wrap;
    if (!opts || !validEditOp(opts.op) || !validValueExpr(opts.thickness, { positive: true })) {
      return { error: 'malformed wrap edit spec' };
    }
    let faceText = parsed.faceText;
    if (opts.face !== undefined) {
      if (spec.parts.length !== 1) {
        return { error: 'malformed wrap edit spec: a re-picked face is exactly one part' };
      }
      const part = spec.parts[0];
      faceText = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
    } else if (spec.parts.length > 0) {
      return { error: 'malformed wrap edit spec: selector parts without a re-picked face' };
    }
    let sketchText = parsed.sketchText;
    if (opts.sketch !== undefined && opts.sketch.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.sketch.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      sketchText = varName;
    }
    return {
      statement: renderWrapStatement({ op: opts.op, thickness: opts.thickness }, sketchText, faceText),
    };
  }
  if (parsed.feature === 'revolve') {
    const opts = spec.edit?.revolve;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validValueExpr(opts.angle, { nonzero: true })) {
      return { error: 'malformed revolve edit spec' };
    }
    let axisExpr = parsed.axisText;
    if (opts.axis !== undefined) {
      if (opts.axis.kind === 'selector') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed revolve edit spec: a re-picked axis is exactly one part' };
        }
      } else if (opts.axis.kind === 'axis' && !isAxisProducer(spec as ApplyFeatureEditSpec, opts.axis.producer)) {
        return { error: 'malformed revolve edit spec: the axis references a non-axis producer' };
      } else if (opts.axis.kind === 'standard'
        && opts.axis.axis !== 'x' && opts.axis.axis !== 'y' && opts.axis.axis !== 'z') {
        return { error: 'malformed revolve edit spec: bad standard axis' };
      }
      axisExpr = renderRevolveAxisExpr(opts.axis, spec.parts, varFor);
    } else if (spec.parts.length > 0) {
      return { error: 'malformed revolve edit spec: selector parts without a re-sourced axis' };
    }
    let profileText = parsed.profileText;
    if (opts.profile !== undefined && opts.profile.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.profile.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      profileText = varName;
    }
    return {
      statement: renderRevolveStatement(
        { op: opts.op, angle: opts.angle, thin: opts.thin }, axisExpr, profileText,
      ),
    };
  }
  if (parsed.feature === 'helix') {
    const opts = spec.edit?.helix;
    if (!opts
      || !validValueExprOrNull(opts.radius, { positive: true })
      || !validValueExprOrNull(opts.endRadius, { positive: true })
      || !validValueExprOrNull(opts.pitch, { nonzero: true })
      || !validValueExprOrNull(opts.turns, { positive: true })
      || !validValueExprOrNull(opts.height, { positive: true })
      || !validValueExprOrNull(opts.startOffset)
      || !validValueExprOrNull(opts.endOffset)) {
      return { error: 'malformed helix edit spec' };
    }
    let sourceExpr = parsed.sourceText;
    if (opts.source !== undefined) {
      if (opts.source.kind === 'edge' || opts.source.kind === 'face') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed helix edit spec: a re-picked source is exactly one part' };
        }
      } else if (opts.source.kind === 'axis'
        && !isAxisProducer(spec as ApplyFeatureEditSpec, opts.source.producer)) {
        return { error: 'malformed helix edit spec: the source references a non-axis producer' };
      } else if (opts.source.kind === 'standard'
        && opts.source.axis !== 'x' && opts.source.axis !== 'y' && opts.source.axis !== 'z') {
        return { error: 'malformed helix edit spec: bad standard axis' };
      }
      sourceExpr = renderHelixSourceExpr(opts.source, spec.parts, varFor);
    } else if (spec.parts.length > 0) {
      return { error: 'malformed helix edit spec: selector parts without a re-sourced source' };
    }
    return { statement: renderHelixStatement(opts, sourceExpr) };
  }
  if (parsed.feature === 'loft') {
    const opts = spec.edit?.loft;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validEditCondition(opts.startCondition) || !validEditCondition(opts.endCondition)) {
      return { error: 'malformed loft edit spec' };
    }
    const sources = resolveLoftSources(parsed, spec, varFor);
    if ('error' in sources) {
      return sources;
    }
    // The guides⊕thin exclusion holds for the statement being WRITTEN — the
    // edited guide list when one rides the spec, not the stale parsed one.
    if (sources.guideExprs.length > 0 && opts.thin) {
      return { error: 'loft guides cannot be combined with thin walls' };
    }
    return {
      statement: renderLoftStatement(
        { op: opts.op, thin: opts.thin, startCondition: opts.startCondition, endCondition: opts.endCondition },
        sources.profileExprs,
        sources.guideExprs,
      ),
    };
  }
  if (parsed.feature === 'sketch') {
    const target = spec.edit?.sketch?.target;
    let targetExpr: string;
    if (target?.kind === 'standard') {
      if (target.plane !== 'xy' && target.plane !== 'xz' && target.plane !== 'yz') {
        return { error: 'malformed sketch edit spec: bad standard plane' };
      }
      if (spec.parts.length > 0) {
        return { error: 'malformed sketch edit spec: selector parts on a standard-plane target' };
      }
      targetExpr = `'${target.plane}'`;
    } else if (target?.kind === 'plane') {
      if (!isPlaneProducer(spec as ApplyFeatureEditSpec, target.producer)) {
        return { error: 'malformed sketch edit spec: the target references a non-plane producer' };
      }
      if (spec.parts.length > 0) {
        return { error: 'malformed sketch edit spec: selector parts on a plane-feature target' };
      }
      targetExpr = varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'p';
    } else if (target?.kind === 'selector') {
      // The target argument is ONE SceneObject — a multi-part selection has
      // no single-expression rendering.
      if (spec.parts.length !== 1) {
        return { error: 'malformed sketch edit spec: a re-picked target is exactly one part' };
      }
      const part = spec.parts[0];
      targetExpr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
    } else {
      return { error: 'malformed sketch edit spec' };
    }
    return { statement: `sketch(${targetExpr}, ${parsed.bodyText})` };
  }
  if (parsed.feature === 'repeat') {
    return renderEditedRepeat(parsed, spec, varFor);
  }
  if (parsed.feature === 'copy') {
    return renderEditedCopy(parsed, spec, varFor);
  }
  if (parsed.feature === 'boolean') {
    return renderEditedBoolean(parsed, spec, varFor);
  }
  if (parsed.feature === 'plane') {
    return renderEditedPlane(parsed, spec, varFor);
  }
  if (parsed.feature === 'text') {
    const opts = spec.edit?.text;
    if (!opts || typeof opts.text !== 'string'
      || typeof opts.size !== 'number' || !Number.isFinite(opts.size) || opts.size <= 0
      || (opts.font !== null && typeof opts.font !== 'string')
      || typeof opts.weight !== 'number' || opts.weight % 100 !== 0 || opts.weight < 100 || opts.weight > 900
      || typeof opts.italic !== 'boolean'
      || !TEXT_DIALOG_ALIGNS.has(opts.align)
      || typeof opts.lineSpacing !== 'number' || !Number.isFinite(opts.lineSpacing) || opts.lineSpacing <= 0
      || typeof opts.letterSpacing !== 'number' || !Number.isFinite(opts.letterSpacing)) {
      return { error: 'malformed text edit spec' };
    }
    if (opts.text.trim() === '') {
      return { error: 'the text string is empty' };
    }
    return { statement: renderTextStatement(opts, parsed.pathText) };
  }
  if (!validValueExpr(spec.value, { nonzero: true })) {
    return { error: `the ${parsed.feature} value must be a nonzero number or expression` };
  }
  let joinChain = '';
  if (parsed.feature === 'shell') {
    // An edit spec without shell options keeps the statement's own join type.
    const joinType = spec.edit?.shell?.joinType ?? parsed.joinType;
    if (!SHELL_JOIN_KINDS.has(joinType)) {
      return { error: 'malformed shell edit spec' };
    }
    joinChain = renderShellJoinChain(joinType);
  }
  let valueArgs = formatValue(spec.value);
  if (parsed.feature === 'chamfer') {
    // An edit spec without chamfer options keeps the statement's own second
    // value; explicit options replace it (null returns to equal distance).
    const chamfer = spec.edit?.chamfer ?? { distance2: parsed.distance2, isAngle: parsed.isAngle };
    if (!validChamferOptions(chamfer)) {
      return { error: 'malformed chamfer edit spec' };
    }
    valueArgs = renderChamferValueArgs(spec.value, chamfer);
  }
  // The user's expression text wins over a re-picked selection (the create
  // path's contract); with neither, the statement's own args stay verbatim.
  const partsArgs = spec.parts.length > 0
    ? spec.parts
      .map(part => renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer)))
      .join(', ')
    : null;
  const args = spec.rawArgs?.trim() || partsArgs || parsed.argsText;
  return {
    statement: args
      ? `${parsed.feature}(${valueArgs}, ${args})${joinChain}`
      : `${parsed.feature}(${valueArgs})${joinChain}`,
  };
}

/**
 * Rewrite the feature statement at `spec.edit.line` in place: re-parse the
 * chain from the live source (nothing captured at dialog-open time can go
 * stale), apply the dialog's options over it, and splice the rendered chain
 * over the old one. A `const x = ` binding and any chained calls after the
 * recognized options survive untouched.
 *
 * Re-sourced slots bind their producers exactly like create mode (reuse an
 * existing `const`, or prepend `const <name> = ` to the bare statement) —
 * with one extra rule the create path never needs: a producer's statement
 * must lie strictly before the edited statement in the same scope, because
 * the rewritten statement executes where it already is. A producer at or
 * after it would be a self or forward reference.
 */
async function applyStatementEdit(code: string, spec: ApplyFeatureEditSpec): Promise<ApplyFeatureEditResult> {
  const edit = spec.edit!;
  if (!Number.isInteger(edit.line) || edit.line < 1) {
    return { newCode: code, error: 'malformed edit spec: bad line' };
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, edit.line);
  if (!call) {
    return { newCode: code, error: `no call found at line ${edit.line} — is the file in sync with the last render?` };
  }
  const chain = parseFeatureChain(call, code, numericVarNames(tree));
  if ('error' in chain) {
    return { newCode: code, error: chain.error };
  }
  if (chain.parsed.feature !== spec.feature) {
    return {
      newCode: code,
      error: `the statement at line ${edit.line} is a ${chain.parsed.feature}, `
        + `expected a ${spec.feature} — is the file in sync with the last render?`,
    };
  }
  if (edit.expectedStatement !== undefined
    && code.slice(chain.start, chain.end) !== edit.expectedStatement) {
    return {
      newCode: code,
      error: 'the statement changed since the dialog opened — re-open it to edit the current code',
    };
  }

  let bindings: ProducerBinding[] = [];
  if (spec.producers.length > 0 || spec.parts.length > 0) {
    const resolved = resolveProducerBindings(tree, lines, spec);
    if ('error' in resolved) {
      return { newCode: code, error: resolved.error };
    }
    bindings = resolved.bindings;

    const editedStatement = enclosingStatement(call);
    if (!editedStatement) {
      return { newCode: code, error: `no statement found at line ${edit.line}` };
    }
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (binding.statement.startIndex >= chain.start) {
        return {
          newCode: code,
          error: `the input at line ${spec.producers[i].line} does not precede the edited statement — `
            + 'a statement cannot consume itself or later results',
        };
      }
      if (!sameNode(binding.scope, enclosingScope(editedStatement))) {
        return {
          newCode: code,
          error: `the input at line ${spec.producers[i].line} lives in a different scope than the edited statement`,
        };
      }
    }
    allocateNames(tree.rootNode, bindings, spec);
  }

  const rendered = renderEditedStatement(
    chain.parsed, spec, producer => bindings[producer]?.varName ?? null,
  );
  if ('error' in rendered) {
    return { newCode: code, error: rendered.error };
  }

  // Splice highest-offset first: producer bindings precede the statement, so
  // the statement replacement never shifts under a `const <name> = ` prepend.
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [{ start: chain.start, end: chain.end, text: rendered.statement }];
  for (const binding of bindings) {
    if (binding.needsBinding) {
      edits.push({ start: binding.call.startIndex, end: binding.call.startIndex, text: `const ${binding.varName} = ` });
    }
  }
  // Declarations a dialog expression field committed land on the line before
  // the edited statement (its `const x = ` binding included), at its indent.
  const stmtNode = enclosingStatement(call);
  const declsResult = renderNewVariableDecls(
    code, spec.newVariables, (stmtNode ?? call).text.trimEnd().endsWith(';'),
  );
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  if (declsResult.decls.length > 0) {
    const anchor = stmtNode ?? call;
    const indent = indentOf(lines, anchor.startPosition.row);
    edits.push({
      start: anchor.startIndex,
      end: anchor.startIndex,
      text: declsResult.decls.map(d => `${d}\n${indent}`).join(''),
    });
  }
  // Ties (a pure insertion at the statement's own start) must splice after
  // the replacement, so the inserted text never lands inside the replaced
  // span — hence the end tie-break.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = code;
  for (const e of edits) {
    result = spliceCode(result, e.start, e.end, e.text);
  }

  const callee = spec.feature === 'extrude'
    ? (edit.extrude!.op === 'remove' ? 'cut' : 'extrude')
    : spec.feature === 'boolean'
      ? edit.boolean!.kind
      : spec.feature;
  result = await ensureSymbolImport(result, callee);
  const imports = new Set(spec.imports ?? []);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      imports.add(symbol);
    }
  }
  if (declsResult.paramDecls.length > 0) {
    imports.add('param');
  }
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
  result = await insertDeclsAfterImports(result, declsResult.paramDecls);
  // Clearing the edit's breakpoint here — one transform, one write — keeps
  // the rewrite and the clear from racing had the UI cleared it separately.
  if (spec.clearBreakpoints) {
    result = (await stripBreakpoints(result)).newCode;
  }
  return { newCode: result };
}

/**
 * End-of-scope insertion point: after the scope's last statement, but before
 * a trailing `return`. Inserting at the end matches what the user saw — the
 * picked edges survived to the final model, so resolving the selection after
 * the last statement is guaranteed to find them. `indent` is the statement
 * indent at the insertion point, for statements with internal newlines.
 *
 * With an active `breakpoint();` the model the user saw is the paused one —
 * statements after the breakpoint never ran and the selection resolved
 * against the paused state — so the statement lands before the first
 * breakpoint that follows the producers, not after it.
 */
function findInsertionPoint(
  scope: TSNode,
  lines: string[],
  bindings: ProducerBinding[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  const children = scope.namedChildren;

  const latestProducerEnd = Math.max(...bindings.map(b => b.statement.endIndex));
  const breakpointStmt = children.find(c => isBreakpointStatement(c) && c.startIndex >= latestProducerEnd);
  if (breakpointStmt) {
    const indent = indentOf(lines, breakpointStmt.startPosition.row);
    return { index: breakpointStmt.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const last = children.length > 0 ? children[children.length - 1] : null;

  if (last && last.type === 'return_statement') {
    const indent = indentOf(lines, last.startPosition.row);
    return { index: last.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const anchor = last ?? bindings[0].statement;
  const indent = indentOf(lines, anchor.startPosition.row);
  return { index: anchor.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}
