// The parsed shape of an editable feature statement and the callees/chain members that make one.

import type { BooleanKind } from '../features/boolean.ts';
import type { ConnectorRotateAxis } from '../features/connector.ts';
import type { ExtrudeTargetKind } from '../features/extrude.ts';
import type { LoftConditionSpec } from '../features/loft.ts';
import type { ParsedPlaneBase, PlaneRotationAxes } from '../features/plane.ts';
import type { ProjectionOp } from '../features/projection.ts';
import type { ShellJoinKind } from '../features/shell.ts';
import type { RegionKey, ValueExpr } from '../value-expr.ts';

/** Feature kinds whose statements the edit dialogs can rewrite in place. */
export type EditableFeatureKind = 'extrude' | 'sweep' | 'loft' | 'shell' | 'fillet' | 'chamfer' | 'revolve' | 'text' | 'wrap' | 'sketch' | 'repeat' | 'copy' | 'mirror' | 'rotate' | 'boolean' | 'helix' | 'plane' | 'offset' | 'project' | 'rib' | 'connector';

/**
 * A statement's parsed `.scope(…)` chain, shared by every feature that
 * writes one (rib, extrude, sweep, loft, revolve). `scopeTexts` carries the
 * argument expressions verbatim; `scopeRefs` (same length) carries the
 * source location of the feature statement each argument references — a
 * plain identifier's bound call — or null when it names none; it lets the
 * edit dialog seed scope chips as their solid rows.
 */
export type ParsedScopeChain = {
  /** `.scope(…)` argument texts, verbatim; empty when the chain is absent. */
  scopeTexts: string[];
  /** Statement location per argument, or null (same length as `scopeTexts`). */
  scopeRefs: ({ line: number; column: number } | null)[];
};

export type ParsedRegionChain = {
  /** `.region(…)` arguments — keys and positions; empty when the chain is absent or bare. */
  regions: RegionKey[];
};

/**
 * An existing statement's dialog-editable reading. Argument expressions the
 * dialogs don't edit (profiles, paths, selector args) are carried as
 * verbatim source text and re-emitted unchanged; numeric options must be
 * plain literals — a variable distance is edited through the params panel,
 * not this dialog.
 */
export type ParsedFeatureStatement =
  | (ParsedScopeChain & ParsedRegionChain & {
    feature: 'extrude';
    op: 'add' | 'remove' | 'new';
    /** null = through-all remove (`cut()` with no distance). */
    distance: ValueExpr | null;
    /** Second distance of a two-distance `extrude(d1, d2)`, or null. */
    distance2: ValueExpr | null;
    symmetric: boolean;
    /** `.draft(angle)` taper in degrees, or null when the chain is absent. */
    draft: ValueExpr | null;
    /** `.endOffset(value)` pull-back, or null when the chain is absent. */
    endOffset: ValueExpr | null;
    drill: boolean;
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
    /** Up-to-face target argument text, or null for a distance extrude. */
    toFaceText: string | null;
    /**
     * The target's kind — a picked face's selector, or the first/last-face
     * literal; null for a distance extrude.
     */
    toFaceKind: ExtrudeTargetKind | null;
  })
  | (ParsedScopeChain & {
    feature: 'rib';
    op: 'add' | 'remove' | 'new';
    /** Wall thickness; the sign picks the side of the sketch plane. */
    thickness: ValueExpr;
    parallel: boolean;
    extend: boolean;
    /** `.draft(angle)` taper in degrees, or null when the chain is absent. */
    draft: ValueExpr | null;
    /** Trailing spine argument text (`s`), or null for implicit consumption. */
    spineText: string | null;
  })
  | (ParsedScopeChain & ParsedRegionChain & {
    feature: 'sweep';
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** `.extend('start', …)` lead-in, or null when the chain is absent. */
    extendStart: ValueExpr | null;
    /** `.extend('end', …)` run-out, or null when the chain is absent. */
    extendEnd: ValueExpr | null;
    pathText: string;
    profileText: string | null;
  })
  | (ParsedRegionChain & {
    feature: 'wrap';
    op: 'add' | 'remove' | 'new';
    /** Pad thickness along the surface normal (always positive). */
    thickness: ValueExpr;
    /** Sketch argument text, verbatim (`s`). */
    sketchText: string;
    /** Target face argument text, verbatim (`e.sideFaces(0)`). */
    faceText: string;
  })
  | (ParsedScopeChain & ParsedRegionChain & {
    feature: 'revolve';
    op: 'add' | 'remove' | 'new';
    /** Sweep angle in degrees; null = omitted (the 360° API default). */
    angle: ValueExpr | null;
    /** `.symmetric()` chained on the statement. */
    symmetric: boolean;
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    /** Axis argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`). */
    axisText: string;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
  })
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
  | (ParsedScopeChain & {
    feature: 'loft';
    op: 'add' | 'remove' | 'new';
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    profileTexts: string[];
    guideTexts: string[];
    connectionTexts: string[][];
    /** Kept argument lists, including comments and whitespace. */
    connectionArgs: string[];
    startCondition: LoftConditionSpec | null;
    endCondition: LoftConditionSpec | null;
  })
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
    feature: 'offset';
    /** The offset distance; negative offsets inward. */
    value: ValueExpr;
    /** Target argument list after the value slot, verbatim (`''` when absent). */
    argsText: string;
    /** `.close()` chains the offset back onto its source profile. */
    close: boolean;
  }
  | {
    feature: 'project';
    /** Which callee the statement uses — `project()` or `intersect()`. */
    op: ProjectionOp;
    /** The projected source argument list, verbatim (`''` when absent). */
    argsText: string;
  }
  | {
    feature: 'connector';
    /** The identifier the statement registers the connector under. */
    name: string;
    /**
     * The source argument, verbatim — the anchor suffix included, since
     * `.center()` / `.offset('relative', 0.3)` is part of the expression the
     * dialog's source row shows and edits (`e.endFaces(0).center()`).
     */
    argsText: string;
    /** `.rotate('<axis>', deg)`, or null when the chain is absent. */
    rotate: { axis: ConnectorRotateAxis; angle: number } | null;
    /** `.offset(x[, y, z])` with the omitted components read as 0; null when absent. */
    offset: [number, number, number] | null;
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
    /** The trailing solved-mode flag (`true`/`false`), verbatim; null when
     * absent. A retarget must re-render it — dropping it would silently
     * flip a solved sketch back to legacy. */
    solvedText: string | null;
  }
  | {
    feature: 'text';
    text: string;
    size: number;
    /** `.font()` family/file, or null when the chain is absent. */
    font: string | null;
    weight: number;
    italic: boolean;
    align: 'left' | 'center' | 'right' | 'space-between' | 'space-around';
    lineSpacing: number;
    letterSpacing: number;
    /** The path-only chains; defaults when absent (0 / 0 / false). */
    offset: number;
    startAt: number;
    flip: boolean;
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
    /**
     * The 2D in-sketch circular form's center point, parsed from its
     * `[x, y]` argument; null for every axis form.
     */
    center: [ValueExpr, ValueExpr] | null;
    /**
     * The instances the statement leaves out, one index per direction — a
     * circular copy's flat indices come back as single-index tuples. Null when
     * the statement names none.
     */
    skip: number[][] | null;
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
    feature: 'mirror';
    /** The op the statement's chain names — `.remove()`, `.new()`, or add. */
    op: 'add' | 'remove' | 'new';
    /** Mirror plane argument text, verbatim. */
    planeText: string;
    /** Trailing target texts, verbatim; empty mirrors the previous feature. */
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
    feature: 'rotate';
    /** Rotation axis argument text, verbatim. */
    axisText: string;
    /** The rotation angle in degrees. */
    angle: ValueExpr;
    /** The `true` third argument — copy instead of move. */
    copy: boolean;
    /** Trailing target texts, verbatim; empty rotates every active object. */
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
    /** The axes the rotations turn around; `local` when the statement writes none. */
    rotationAxes: PlaneRotationAxes;
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

export const EDITABLE_CALLEES: Record<string, EditableFeatureKind> = {
  extrude: 'extrude',
  cut: 'extrude',
  rib: 'rib',
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
  // The 3D `mirror(plane, …)` only — the 2D in-sketch form shares the callee,
  // and the client routes its rows away by uniqueType before asking.
  mirror: 'mirror',
  // The 3D `rotate(axis, angle, …)` only — the 2D in-sketch form shares the
  // callee the same way, and the client gates its rows by uniqueType too.
  rotate: 'rotate',
  fuse: 'boolean',
  subtract: 'boolean',
  common: 'boolean',
  helix: 'helix',
  plane: 'plane',
  offset: 'offset',
  // Both sketch-reference callees open the projection dialog; the parse
  // reports which one under `op` so the rewrite keeps the callee.
  project: 'project',
  intersect: 'project',
  connector: 'connector',
};

/**
 * Chain members the dialogs edit, per feature. They must form a prefix of
 * the member chain: anything after the first unrecognized member (a chained
 * `.fillet()`, `.color()` …) is preserved verbatim, but a recognized member
 * hiding *behind* an unrecognized one would leave the dialog lying about the
 * statement, so that shape refuses to parse.
 */
export const OPTION_MEMBERS: Record<EditableFeatureKind, Set<string>> = {
  extrude: new Set(['region', 'symmetric', 'draft', 'endOffset', 'drill', 'thin', 'remove', 'new', 'scope']),
  rib: new Set(['parallel', 'extend', 'draft', 'remove', 'new', 'scope']),
  // `.extend()` may chain twice — once per end — so the parse collects it
  // like loft's `.connect()` instead of refusing the repeat.
  sweep: new Set(['region', 'extend', 'thin', 'remove', 'new', 'scope']),
  loft: new Set(['connect', 'guides', 'startCondition', 'endCondition', 'thin', 'remove', 'new', 'scope']),
  shell: new Set(['join']),
  fillet: new Set(),
  chamfer: new Set(),
  revolve: new Set(['region', 'symmetric', 'thin', 'remove', 'new', 'scope']),
  text: new Set(['font', 'size', 'weight', 'bold', 'italic', 'align', 'lineSpacing', 'letterSpacing', 'offset', 'startAt', 'flip']),
  // Wrap has no thin mode — the region picks and the boolean-operation chains.
  wrap: new Set(['region', 'remove', 'new']),
  // The dialog edits only the target argument; `.name()` and friends are
  // unrecognized members and survive verbatim after the root call.
  sketch: new Set(),
  // Everything the dialog edits lives in the root call's arguments; `.name()`
  // and friends are unrecognized members and survive verbatim.
  repeat: new Set(),
  // Like repeat: everything lives in the root call's arguments.
  copy: new Set(),
  // The plane and targets are root-call arguments; the operation chains are
  // the one thing the dialog edits. `.scope()`/`.exclude()`/`.name()` are
  // unrecognized members and survive verbatim.
  mirror: new Set(['add', 'remove', 'new']),
  // The axis, angle, copy flag and targets are all root-call arguments;
  // `.exclude()`/`.name()` are unrecognized members and survive verbatim.
  rotate: new Set(),
  // The targets are the root call's arguments; `.name()` and friends are
  // unrecognized members and survive verbatim.
  boolean: new Set(),
  // The single source is the root argument; every geometry option is a chained
  // configurator. A helix is a wire, so there is no boolean-operation chain.
  helix: new Set(['radius', 'endRadius', 'pitch', 'turns', 'height', 'startOffset', 'endOffset']),
  // The bases and the transform options are all root-call arguments; `.name()`
  // and friends are unrecognized members and survive verbatim.
  plane: new Set(),
  // The distance, the removeOriginal flag and the targets are root-call
  // arguments; `.close()` is the one chained option the dialog edits.
  offset: new Set(['close']),
  // The sources are the root call's arguments; `.name()` and friends are
  // unrecognized members and survive verbatim.
  project: new Set(),
  // The name and the source (anchor suffix included) are root-call arguments;
  // the frame adjustments are the chained options the dialog edits. They are
  // order-sensitive — an offset walks the ROTATED axes — so the parse also
  // requires the writer's own order (rotate, then offset).
  connector: new Set(['rotate', 'offset']),
};

export type ChainParse =
  | { parsed: ParsedFeatureStatement; start: number; end: number }
  | { error: string };
