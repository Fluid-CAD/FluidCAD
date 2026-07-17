import {
  getJavaScriptParser,
  ensureSymbolImport,
  findEditableCallAt,
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
 * Mirror of `lib/selection/types.ts` `ApplyFeatureEditSpec` — the wire
 * contract between the synthesis layer and this transform. Kept structural
 * here so the transform stays a dependency-free string function.
 */
export type ApplyFeatureEditSpec = {
  feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'text' | 'wrap';
  /** Numeric parameter (radius/distance/thickness); absent for sketch. */
  value?: number;
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
  /** Shell-only payload; the join type chains after the selector args. */
  shell?: ShellEditOptions;
  /** Loft-only payload; each `parts` entry renders one profile's selector. */
  loft?: LoftEditOptions;
  /** Plane-only payload; each `parts` entry renders one base's selector. */
  plane?: PlaneEditOptions;
  /** Revolve-only payload; `parts` (if any) render the axis-edge selector. */
  revolve?: RevolveEditOptions;
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
    distance: number | null;
    distance2: number | null;
    symmetric: boolean;
    draft: number | null;
    drill: boolean;
    thin: [number] | [number, number] | null;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
    /**
     * Up-to-face target: `keep` re-emits the statement's own target text,
     * `selector` renders the re-picked face from `parts`. Absent writes the
     * distance form (dropping any target the statement had).
     */
    toFace?: { kind: 'keep' } | { kind: 'selector' };
  };
  sweep?: {
    op: 'add' | 'remove' | 'new';
    thin: [number] | [number, number] | null;
    /** Re-sourced path; absent keeps the statement's path text. */
    path?: EditPathSource;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
  };
  wrap?: {
    op: 'add' | 'remove' | 'new';
    thickness: number;
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
  loft?: {
    op: 'add' | 'remove' | 'new';
    thin: [number] | [number, number] | null;
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
    angle: number;
    thin: [number] | [number, number] | null;
    /** Re-sourced profile; absent keeps the statement's profile text. */
    profile?: EditSketchSource;
    /** Re-sourced axis; absent keeps the statement's axis text. */
    axis?: RevolveAxisSpec;
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
 * How an extrude statement is rendered and placed. The single producer is the
 * profile *sketch* call. `implicit` inserts at the end of the sketch's scope
 * and consumes it as the last sketch (`extrude(25)`); `bound` binds the sketch
 * to a variable and inserts directly after its statement (`const s = …;
 * extrude(25, s)`) so a later active sketch stays active.
 */
export type ExtrudeEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null renders a through-all `cut()` (remove only). */
  distance: number | null;
  /**
   * Opposite-direction distance; non-null renders the two-distance form
   * `extrude(d1, d2)`. Excludes `symmetric` and a through-all `distance`.
   */
  distance2: number | null;
  /** `.symmetric()` — the distance is split equally across the sketch plane. */
  symmetric: boolean;
  /** `.draft(angle)` taper in degrees, or null for a straight extrude. */
  draft: number | null;
  /** False renders `.drill(false)` — inner closed regions extrude as solid. */
  drill: boolean;
  /** `.thin(a)` / `.thin(a, b)` offsets, or null for a plain extrude. */
  thin: [number] | [number, number] | null;
  profile: 'implicit' | 'bound';
  /**
   * Up-to-face mode: the single selector part (a picked face) renders as the
   * call's first argument — `extrude(<face>[, s])` / `cut(<face>[, s])` —
   * in place of the distance(s). Excludes `distance`/`distance2`/`symmetric`.
   */
  toFace?: boolean;
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
  thin: [number] | [number, number] | null;
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
  thickness: number;
  sketch: { producer: number };
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
  angle: number;
  thin: [number] | [number, number] | null;
  profile: 'implicit' | 'bound';
  axis: RevolveAxisSpec;
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
  thin: [number] | [number, number] | null;
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
  magnitude: number;
};

/**
 * One base of a plane statement: a standard origin plane (renders as its
 * string literal, no producer involved), a picked face/edge rendered from a
 * `parts` entry, or an existing plane feature bound to a variable.
 */
export type PlaneBaseSpec =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'selector'; part: number }
  | { kind: 'plane'; producer: number };

/**
 * How a plane statement is rendered and placed: `plane(<base>)` for an offset
 * plane — with a bare numeric offset (`plane('xy', 10)`) or a transform
 * options object when rotation rides along — `plane(<b1>, <b2>, …)` for a
 * mid plane, or `plane(<edge>, <position>)` for a plane normal to an edge at
 * a 0–1 position along it. A mid base must be plane-like, so a picked
 * face/edge selector is wrapped in its own `plane(…)` there. With only
 * standard bases the spec carries no producers at all and the statement
 * appends at top level; with plane-variable bases and no selectors it inserts
 * right after the latest input statement; any selector base forces
 * end-of-scope insertion, where the picked geometry is known to resolve.
 */
export type PlaneEditOptions = {
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null/0 renders none. Offset/mid types only. */
  offset: number | null;
  /** Rotation in degrees around the plane's local axes; null/0 renders none. */
  rotateX: number | null;
  rotateY: number | null;
  rotateZ: number | null;
  /** Normalized 0–1 position along the edge (edge type only). */
  position?: number | null;
  /** One base for an offset/edge plane, two for a mid plane. */
  bases: PlaneBaseSpec[];
};

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
    // producers[0]. A distance extrude carries no selector parts; a to-face
    // extrude carries exactly one — the target face, whose own producers
    // follow the profile in the list.
    const valid = spec.extrude !== undefined && spec.producers.length >= 1
      && (spec.extrude.toFace
        ? spec.parts.length === 1
        : spec.producers.length === 1 && spec.parts.length === 0);
    if (!valid) {
      return { newCode: code, error: 'malformed extrude edit spec' };
    }
  } else if (spec.feature === 'sweep') {
    const sw = spec.sweep;
    const sketchProducer = (i: number) => isSketchProducer(spec, i);
    const valid = sw !== undefined
      && spec.producers.length > 0
      && (sw.path.kind === 'selector'
        ? spec.parts.length >= 1
        : spec.parts.length === 0 && sketchProducer(sw.path.producer))
      && (sw.profile === 'implicit' || sketchProducer(sw.profile.producer));
    if (!valid) {
      return { newCode: code, error: 'malformed sweep edit spec' };
    }
  } else if (spec.feature === 'wrap') {
    // The sketch is always a bound producer (wrap never consumes the active
    // sketch implicitly); the single selector part is the target face, whose
    // own producers ride the list alongside the sketch.
    const wr = spec.wrap;
    const valid = wr !== undefined
      && Number.isFinite(wr.thickness) && wr.thickness > 0
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
      && Number.isFinite(rev.angle) && rev.angle !== 0
      && (rev.axis.kind === 'selector'
        ? spec.parts.length === 1
        : spec.parts.length === 0
          && (rev.axis.kind === 'standard'
            ? spec.producers.length === 1
            : isAxisProducer(spec, rev.axis.producer)));
    if (!valid) {
      return { newCode: code, error: 'malformed revolve edit spec' };
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
      && guides.every(g => g?.kind === 'sketch' && isSketchProducer(spec, g.producer))
      && [lo.startCondition, lo.endCondition].every(c => c === undefined
        || ((c.type === 'normal' || c.type === 'tangent')
          && Number.isFinite(c.magnitude) && c.magnitude !== 0));
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
            : b?.kind === 'selector' && Number.isInteger(b.part) && b.part >= 0 && b.part < spec.parts.length)
      // Every selector part belongs to exactly one base.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ]
        .every(v => v === null || (typeof v === 'number' && Number.isFinite(v)))
      // The edge form is a picked edge plus a normalized position — the
      // second argument slot is taken, so no offset/rotation can ride.
      && (pl.type !== 'edge' || (
        pl.bases[0]?.kind === 'selector'
        && typeof pl.position === 'number' && Number.isFinite(pl.position)
        && pl.position >= 0 && pl.position <= 1
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
      );
    }
  } else if (spec.feature === 'sketch' && spec.sketchOnPlane) {
    // The single producer is the plane statement the sketch targets; there is
    // no selector to render.
    const valid = spec.producers.length === 1 && isPlaneProducer(spec, 0) && spec.parts.length === 0;
    if (!valid) {
      return { newCode: code, error: 'malformed sketch-on-plane edit spec' };
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

  const insertion = resolveInsertion(spec, bindings, scope, lines);
  const statementText = buildStatement(spec, bindings, insertion.indent);
  const useSemicolon = bindings.some(b => b.statement.text.trimEnd().endsWith(';'));

  type Edit = { index: number; text: string };
  const edits: Edit[] = [
    { index: insertion.index, text: insertion.wrap(statementText + (useSemicolon ? ';' : '')) },
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
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
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
): Promise<ApplyFeatureEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const children = tree.rootNode.namedChildren;
  const last = children.length > 0 ? children[children.length - 1] : null;

  let result: string;
  if (!last) {
    result = spliceCode(code, code.length, code.length, `${statementFor('')};\n`);
  } else {
    const useSemicolon = children.some(c => c.text.trimEnd().endsWith(';'));
    const before = children.find(isBreakpointStatement)
      ?? (last.type === 'return_statement' ? last : null);
    const indent = indentOf(lines, (before ?? last).startPosition.row);
    const statement = `${statementFor(indent)}${useSemicolon ? ';' : ''}`;
    result = before
      ? spliceCode(code, before.startIndex, before.startIndex, `${statement}\n${indent}`)
      : spliceCode(code, last.endIndex, last.endIndex, `\n${indent}${statement}`);
  }
  return { newCode: await ensureSymbolImport(result, callee) };
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
      // Sketch/plane producers must name their own call — the pick features
      // never attribute to one, so the looser callee stays scoped by type.
      const requiredRoot = requiredChainRoot(producer.featureType ?? '');
      const valid = requiredRoot ? root === requiredRoot : root !== null && PRODUCER_CALLEES.has(root);
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

/**
 * Producer feature types whose source line must hold exactly that call —
 * sketch, plane and axis inputs are referenced by identity, so any other
 * callee at the line means the file is out of sync. Null falls back to the
 * general `PRODUCER_CALLEES` allowlist.
 */
function requiredChainRoot(featureType: string): 'sketch' | 'plane' | 'axis' | null {
  if (featureType === 'sketch') {
    return 'sketch';
  }
  if (featureType === 'plane') {
    return 'plane';
  }
  if (featureType === 'axis') {
    return 'axis';
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

    // Sketch and plane producers (profiles, paths, plane bases) must anchor
    // their own call in both modes — a stale line pointing at some other call
    // would consume the wrong input.
    const requiredRoot = requiredChainRoot(producer.featureType);
    if (requiredRoot) {
      const root = chainRootCallee(call);
      if (root !== requiredRoot) {
        return {
          error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
            + `expected a ${requiredRoot}() call — is the file in sync with the last render?`,
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
    const validCallee = requiredRoot
      ? root === requiredRoot
      : root !== null && PRODUCER_CALLEES.has(root);
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
  return spec.feature;
}

/** The `.thin(…)` / `.remove()` / `.new()` chains shared by sweep and loft. */
function renderOpChains(opts: {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
}): string {
  let chains = '';
  if (opts.thin) {
    chains += `.thin(${opts.thin.map(formatNumber).join(', ')})`;
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
  return `wrap(${formatNumber(wr.thickness)}, ${sketchExpr}, ${faceExpr})`
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
    args.push(formatNumber(rev.angle));
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
  const magnitude = condition.magnitude === 1 ? '' : `, ${formatNumber(condition.magnitude)}`;
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
    return `select(${selectorArgs})`;
  }
  return `${producerVar}.${part.accessor}(${selectorArgs})`;
}

/**
 * Render an extrude statement from its options: `extrude(25)` / `cut()`
 * (through-all) / `extrude(10, 20)` (two distances) / `extrude(25, s)` for a
 * bound profile / `extrude(<faceExpr>)` for a to-face extrude, plus
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
    callArgs.push(formatNumber(ext.distance));
    if (ext.distance2 !== null) {
      callArgs.push(formatNumber(ext.distance2));
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
    statement += `.draft(${formatNumber(ext.draft)})`;
  }
  if (!ext.drill) {
    // True is the API default, so only the opt-out is written.
    statement += '.drill(false)';
  }
  if (ext.thin) {
    statement += `.thin(${ext.thin.map(formatNumber).join(', ')})`;
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
export function renderPlaneStatement(pl: PlaneEditOptions, baseExprs: string[]): string {
  if (pl.type === 'edge') {
    // The second argument is the normalized position, not an offset — the
    // edge form takes no transform options.
    return `plane(${baseExprs[0]}, ${formatNumber(pl.position ?? 0)})`;
  }
  const entries: string[] = [];
  if (pl.offset !== null && pl.offset !== 0) {
    entries.push(`offset: ${formatNumber(pl.offset)}`);
  }
  const rotations: [string, number | null][] = [
    ['rotateX', pl.rotateX], ['rotateY', pl.rotateY], ['rotateZ', pl.rotateZ],
  ];
  let hasRotation = false;
  for (const [key, value] of rotations) {
    if (value !== null && value !== 0) {
      hasRotation = true;
      entries.push(`${key}: ${formatNumber(value)}`);
    }
  }
  let optionsArg = '';
  if (entries.length > 0) {
    optionsArg = !hasRotation && pl.type === 'offset'
      ? `, ${formatNumber(pl.offset!)}`
      : `, { ${entries.join(', ')} }`;
  }
  return `plane(${baseExprs.join(', ')}${optionsArg})`;
}

/**
 * Render each plane base as an expression: `'xy'` for a standard plane, the
 * bound variable for an existing plane feature, or the selector part for a
 * picked face/edge. A mid plane needs plane-like arguments, so a raw selector
 * is wrapped in its own `plane(…)` there. Shared with the route, which passes
 * its namer's variables; the transform passes its bindings'.
 */
export function renderPlaneBaseExprs(
  pl: PlaneEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string[] {
  return pl.bases.map(base => {
    if (base.kind === 'standard') {
      return `'${base.plane}'`;
    }
    if (base.kind === 'plane') {
      return varFor(base.producer) ?? 'p';
    }
    const part = parts[base.part];
    const expr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
    return pl.type === 'mid' ? `plane(${expr})` : expr;
  });
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
    const facePart = spec.extrude!.toFace ? spec.parts[0] : null;
    const faceExpr = facePart
      ? renderSelectorPartExpr(facePart, facePart.producer === null ? null : bindings[facePart.producer].varName)
      : null;
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
  const joinChain = spec.feature === 'shell' ? renderShellJoinChain(spec.shell?.joinType) : '';
  return `${spec.feature}(${formatNumber(spec.value)}, ${args})${joinChain}`;
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
function resolveInsertion(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  scope: TSNode,
  lines: string[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  // A to-face extrude references a face selector, which must resolve on the
  // final model — end of scope, even with a bound profile.
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
  if (spec.feature === 'plane') {
    // Selector-free bases are explicit plane variables (standard-only specs
    // never reach here — they append at top level with no producers at all):
    // insert right after the latest input statement.
    const planeBases = spec.plane!.bases
      .filter((b): b is { kind: 'plane'; producer: number } => b.kind === 'plane');
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

// ---------------------------------------------------------------------------
// In-place statement editing (timeline double-click → edit dialog)
// ---------------------------------------------------------------------------

/** Feature kinds whose statements the edit dialogs can rewrite in place. */
export type EditableFeatureKind = 'extrude' | 'sweep' | 'loft' | 'shell' | 'fillet' | 'chamfer' | 'revolve' | 'text' | 'wrap' | 'sketch';

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
    distance: number | null;
    /** Second distance of a two-distance `extrude(d1, d2)`, or null. */
    distance2: number | null;
    symmetric: boolean;
    /** `.draft(angle)` taper in degrees, or null when the chain is absent. */
    draft: number | null;
    drill: boolean;
    thin: [number] | null;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
    /** Up-to-face target argument text, or null for a distance extrude. */
    toFaceText: string | null;
  }
  | {
    feature: 'sweep';
    op: 'add' | 'remove' | 'new';
    thin: [number] | null;
    pathText: string;
    profileText: string | null;
  }
  | {
    feature: 'wrap';
    op: 'add' | 'remove' | 'new';
    /** Pad thickness along the surface normal (always positive). */
    thickness: number;
    /** Sketch argument text, verbatim (`s`). */
    sketchText: string;
    /** Target face argument text, verbatim (`e.sideFaces(0)`). */
    faceText: string;
  }
  | {
    feature: 'revolve';
    op: 'add' | 'remove' | 'new';
    /** Sweep angle in degrees; null = omitted (the 360° API default). */
    angle: number | null;
    thin: [number] | null;
    /** Axis argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`). */
    axisText: string;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
  }
  | {
    feature: 'loft';
    op: 'add' | 'remove' | 'new';
    thin: [number] | null;
    profileTexts: string[];
    guideTexts: string[];
    startCondition: LoftConditionSpec | null;
    endCondition: LoftConditionSpec | null;
  }
  | {
    feature: 'shell';
    value: number;
    /** Selector argument list after the value, verbatim (`''` when absent). */
    argsText: string;
    /** `.join()` type; 'arc' (the kernel default) when the chain is absent. */
    joinType: ShellJoinKind;
  }
  | {
    feature: 'fillet' | 'chamfer';
    value: number;
    /** Selector argument list after the value, verbatim (`''` when absent). */
    argsText: string;
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
function parseFeatureChain(call: TSNode, code: string): ChainParse {
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
    const value = numericArgValue(args[0]);
    if (value === null) {
      return { error: `the ${feature}() ${feature === 'shell' ? 'thickness' : feature === 'fillet' ? 'radius' : 'distance'} is not a plain number — edit it in the source` };
    }
    const argsText = args.length > 1
      ? code.slice(args[1].startIndex, args[args.length - 1].endIndex)
      : '';
    if (feature === 'shell') {
      const joinParse = parseJoinSegment(recognized.get('join'));
      if ('error' in joinParse) {
        return joinParse;
      }
      return { parsed: { feature, value, argsText, joinType: joinParse.joinType }, start, end };
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

  const isCut = chain.root.name === 'cut';
  const hasRemove = recognized.has('remove');
  const hasNew = recognized.has('new');
  if ((isCut || hasRemove) && hasNew) {
    return { error: 'the statement chains both a remove and .new()' };
  }
  const op: 'add' | 'remove' | 'new' = isCut || hasRemove ? 'remove' : hasNew ? 'new' : 'add';

  let thin: [number] | null = null;
  const thinSeg = recognized.get('thin');
  if (thinSeg) {
    if (thinSeg.args.length !== 1) {
      return { error: 'only a single-offset .thin() can be edited in the dialog' };
    }
    const offset = numericArgValue(thinSeg.args[0]);
    if (offset === null) {
      return { error: 'the .thin() offset is not a plain number — edit it in the source' };
    }
    thin = [offset];
  }

  if (feature === 'extrude') {
    // Leading numeric literals are distances — one, or two for the
    // two-distance form extrude(d1, d2); a single trailing non-numeric
    // argument is the bound profile expression, kept verbatim. A cut()
    // with no distance is the through-all remove. With NO distance, a call
    // expression (`e.endFaces()`, `select(…)`) is an up-to-face target —
    // two non-numeric arguments are the target and the profile.
    const distances: number[] = [];
    while (distances.length < Math.min(args.length, 2)) {
      const value = numericArgValue(args[distances.length]);
      if (value === null) {
        break;
      }
      distances.push(value);
    }
    const rest = args.slice(distances.length);
    const restLimit = distances.length === 0 ? 2 : 1;
    if (rest.length > restLimit || rest.some(arg => numericArgValue(arg) !== null)) {
      return { error: 'the extrude has more arguments than the dialog understands' };
    }
    if (rest[0]?.type === 'string') {
      // extrude/cut('first-face' | 'last-face'): the target may carry face
      // filters the dialog cannot represent — keep those in the source.
      return { error: `a first-face/last-face ${chain.root.name}() target is not editable in the dialog — edit it in the source` };
    }
    let toFaceText: string | null = null;
    let profileText: string | null = null;
    if (distances.length === 0 && rest.length === 2) {
      // extrude(<face>, <profile>): unambiguous — a two-argument call with
      // no distance is the up-to-face form.
      toFaceText = rest[0].text;
      profileText = rest[1].text;
    } else if (distances.length === 0 && rest.length === 1 && rest[0].type === 'call_expression') {
      // A call expression can't be a bound profile variable — read it as
      // the up-to-face target (matches what the create dialog writes).
      toFaceText = rest[0].text;
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

    let draft: number | null = null;
    const draftSeg = recognized.get('draft');
    if (draftSeg) {
      if (draftSeg.args.length !== 1) {
        return { error: 'the .draft() chain has an argument shape the dialog cannot edit' };
      }
      draft = numericArgValue(draftSeg.args[0]);
      if (draft === null) {
        // Also covers the [start, end] per-side form the dialog doesn't offer.
        return { error: 'the .draft() angle is not a plain number — edit it in the source' };
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

    return { parsed: { feature, op, distance, distance2, symmetric, draft, drill, thin, profileText, toFaceText }, start, end };
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
    const thickness = numericArgValue(args[0]);
    if (thickness === null) {
      return { error: 'the wrap() thickness is not a plain number — edit it in the source' };
    }
    return {
      parsed: { feature, op, thickness, sketchText: args[1].text, faceText: args[2].text },
      start,
      end,
    };
  }

  if (feature === 'revolve') {
    // revolve(<axis>[, <angle>][, <profile>]): the axis is always first,
    // kept verbatim; a numeric second argument is the angle (360 when
    // omitted); a trailing non-numeric argument is the bound profile
    // expression, kept verbatim — the create dialog's own shape. A variable
    // angle is indistinguishable from a profile, so it reads as one; the
    // numeric-literal rule mirrors extrude's distances.
    if (args.length < 1 || args.length > 3) {
      return { error: 'the revolve has more arguments than the dialog understands' };
    }
    const axisText = args[0].text;
    let angle: number | null = null;
    let rest = args.slice(1);
    if (rest.length > 0) {
      const value = numericArgValue(rest[0]);
      if (value !== null) {
        angle = value;
        rest = rest.slice(1);
      }
    }
    if (rest.length > 1 || (rest.length === 1 && numericArgValue(rest[0]) !== null)) {
      return { error: 'the revolve has more arguments than the dialog understands' };
    }
    return {
      parsed: { feature, op, angle, thin, axisText, profileText: rest[0]?.text ?? null },
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
  let magnitude = 1;
  if (seg.args.length === 2) {
    const parsed = numericArgValue(seg.args[1]);
    if (parsed === null || parsed === 0) {
      return { error: `the .${seg.name}() magnitude is not a plain nonzero number — edit it in the source` };
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
  const chain = parseFeatureChain(call, code);
  if ('error' in chain) {
    return { ok: false, reason: chain.error };
  }
  return { ok: true, parsed: chain.parsed, statement: code.slice(chain.start, chain.end) };
}

function validEditOp(op: unknown): op is 'add' | 'remove' | 'new' {
  return op === 'add' || op === 'remove' || op === 'new';
}

function validEditThin(thin: unknown): thin is [number] | [number, number] | null {
  if (thin === null) {
    return true;
  }
  return Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
}

function validEditCondition(condition: LoftConditionSpec | undefined): boolean {
  return condition === undefined
    || ((condition.type === 'normal' || condition.type === 'tangent')
      && Number.isFinite(condition.magnitude) && condition.magnitude !== 0);
}

function validNonzeroOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

/** The spec fields `renderEditedStatement` reads. */
type EditRenderSpec = Pick<ApplyFeatureEditSpec, 'feature' | 'value' | 'rawArgs' | 'edit' | 'producers' | 'parts'>;

/** Variable text of a re-sourced sketch slot: the binding's name, else the hint. */
function editSourceVar(
  spec: EditRenderSpec,
  producer: number,
  varFor: (producer: number) => string | null,
): string | { error: string } {
  if (!isSketchProducer(spec as ApplyFeatureEditSpec, producer)) {
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
    if (opts.toFace !== undefined) {
      if (opts.distance !== null || opts.distance2 !== null || opts.symmetric) {
        return { error: 'a to-face extrude takes no distance and cannot be symmetric' };
      }
      if (opts.toFace.kind === 'keep') {
        if (parsed.toFaceText === null) {
          return { error: 'the statement has no to-face target to keep — pick a face' };
        }
        faceExpr = parsed.toFaceText;
      } else {
        if (spec.parts.length !== 1) {
          return { error: 'malformed extrude edit spec: a re-picked target is exactly one part' };
        }
        const part = spec.parts[0];
        faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
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
      } else if (typeof opts.distance !== 'number' || !Number.isFinite(opts.distance) || opts.distance === 0) {
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
        { ...rest, profile: profileText ? 'bound' : 'implicit', toFace: toFace !== undefined },
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
    if (!opts || !validEditOp(opts.op)
      || typeof opts.thickness !== 'number' || !Number.isFinite(opts.thickness) || opts.thickness <= 0) {
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
      || typeof opts.angle !== 'number' || !Number.isFinite(opts.angle) || opts.angle === 0) {
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
  if (typeof spec.value !== 'number' || !Number.isFinite(spec.value) || spec.value === 0) {
    return { error: `the ${parsed.feature} value must be a nonzero number` };
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
      ? `${parsed.feature}(${formatNumber(spec.value)}, ${args})${joinChain}`
      : `${parsed.feature}(${formatNumber(spec.value)})${joinChain}`,
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
  const chain = parseFeatureChain(call, code);
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
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const e of edits) {
    result = spliceCode(result, e.start, e.end, e.text);
  }

  const callee = spec.feature === 'extrude'
    ? (edit.extrude!.op === 'remove' ? 'cut' : 'extrude')
    : spec.feature;
  result = await ensureSymbolImport(result, callee);
  const imports = new Set(spec.imports ?? []);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      imports.add(symbol);
    }
  }
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
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
