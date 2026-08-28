import { SceneObject, SourceLocation } from "../common/scene-object.js";

/**
 * The read-only slice of Scene the selection kernel consumes. Scene satisfies
 * it structurally, so every existing caller passes a full Scene unchanged;
 * {@link scopedSceneBefore} wraps one to truncate the object list at a
 * statement boundary, making picks resolve against the world that statement
 * sees at build time (its inputs), not the finished model.
 */
export type SelectionScene = {
  getAllSceneObjects(): SceneObject[];
  findEnclosingPart(obj: SceneObject): SceneObject | null;
};

/** View of `scene` truncated to objects strictly before `boundaryIndex`. */
export function scopedSceneBefore(scene: SelectionScene, boundaryIndex: number): SelectionScene {
  const objects = scene.getAllSceneObjects().slice(0, boundaryIndex);
  return {
    getAllSceneObjects: () => objects,
    findEnclosingPart: (obj) => scene.findEnclosingPart(obj),
  };
}

/**
 * The statement whose sources are being re-picked, addressed both ways: by
 * scene position (`index` — the timeline row) and by call site. Selection
 * queries scoped to it run against the objects strictly before it — the
 * world that statement's arguments see at build time.
 */
export type SelectionBoundary = {
  index: number;
  type: string;
  line: number;
  column: number;
};

/**
 * Validate a boundary against the scene and return the truncated view.
 * The index must still hold the same statement's object (call-site match on
 * type + line + column) — a drifted scene refuses instead of silently
 * verifying selectors against the wrong world.
 */
export function resolveScopedScene(
  scene: SelectionScene,
  boundary: SelectionBoundary,
): { ok: true; scene: SelectionScene } | { ok: false; reason: string } {
  const obj = scene.getAllSceneObjects()[boundary.index];
  const loc = obj?.getSourceLocation() ?? null;
  const matches = !!obj && obj.getType() === boundary.type
    && !!loc && loc.line === boundary.line && loc.column === boundary.column;
  if (!matches) {
    return {
      ok: false,
      reason: 'the edited statement no longer matches the rendered scene — re-open the edit dialog',
    };
  }
  return { ok: true, scene: scopedSceneBefore(scene, boundary.index) };
}

/**
 * Connector names key the assembly-side lookup (`instance.connectors.<name>`)
 * and ride generated code as string literals, so they must be plain JS
 * identifiers. Shared by the `connector()` DSL and the synthesis kernel.
 */
export const CONNECTOR_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Exposure names key `def.features.<name>` reads and ride generated code as
 * string literals — same identifier rule as connectors. Shared alias so the
 * two name-first part statements can't drift apart.
 */
export const MEMBER_NAME_PATTERN = CONNECTOR_NAME_PATTERN;

/** A picked sub-shape, exactly as the viewer's `pickAt()` produces it. */
export type PickSubRef = { type: 'edge' | 'face'; index: number };
export type PickRef = { shapeId: string; sub: PickSubRef };

/** Geometric summary of a picked sub-shape, for labels and debugging. */
export type PickDescriptors = {
  geomType: string;
  length?: number;
  area?: number;
  radius?: number;
};

/**
 * JSON-safe explanation of one pick: which feature's classified bucket it
 * belongs to and how the language would name it.
 */
export type PickExplanation = {
  ref: PickRef;
  attributed: boolean;
  error?: string;
  producer?: {
    featureType: string;
    featureName: string;
    /** Producing SceneObject's id — matches the rendered SceneObjectRender.id. */
    featureId: string;
    accessor: string;
    bucketKey: string;
    index: number;
    bucketSize: number;
    sourceLocation: SourceLocation | null;
    sharedCallSite: boolean;
    isClone: boolean;
  };
  /** Set when the pick only attributes through modification lineage. */
  lineage?: {
    classifiedAccessor: string | null;
    classifiedFeatureType: string | null;
    modifiedBy: string[];
  };
  descriptors?: PickDescriptors;
  /** Teach-mode label, e.g. `e.endEdges(2) — end edge of extrude() @ line 4`. */
  expression?: string;
  /**
   * Id of the feature that CREATED the picked sub-shape when no bucket
   * attributes it: the classified ancestor of a since-modified face (the
   * extrude behind a fillet-trimmed side face), or the recorded creator of
   * unclassified geometry (the fillet behind its own arc face). Matches
   * SceneObjectRender.id. Unset when `producer` is present — the producer IS
   * the creator then.
   */
  creatorId?: string;
  /** Id of the statement owning the picked solid — matches SceneObjectRender.id. */
  solidOwnerId?: string;
};

export type ExplainResult = {
  picks: PickExplanation[];
};

export type ApplyFeatureKind = 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'wrap' | 'helix' | 'project' | 'offset' | 'slot' | 'trim' | 'fuse' | 'subtract' | 'common' | 'tarc' | 'aline' | 'text' | 'copy' | 'connector' | 'expose';

/**
 * A tangent chain from the "Select with tangents" gesture: the pick the user
 * right-clicked plus the full expansion (`seed` included in `members`).
 */
export type PickChain = {
  seed: PickRef;
  members: PickRef[];
};

/**
 * Everything the tree-sitter code transform needs, and nothing kernel-side —
 * the transform stays a testable string function.
 */
/**
 * The 2D offset's own options: the `removeOriginal` boolean that rides as the
 * call's second argument, and the `.close()` chain that caps an open offset
 * back onto its source profile. The kernel refuses the pair (there is no
 * original left to cap to), so the two are mutually exclusive here too.
 */
export type OffsetEditOptions = {
  removeOriginal: boolean;
  close: boolean;
};

/**
 * A slot-from-edge statement's own option: the `deleteSource` boolean that
 * rides as the call's third argument. The kernel default is true (the source
 * geometry is consumed), so the rendered statement only carries an explicit
 * `false` when the original is kept.
 */
export type SlotEditOptions = {
  removeOriginal: boolean;
};

export type ApplyFeatureEditSpec = {
  feature: ApplyFeatureKind;
  /** Numeric parameter (radius/distance/thickness); absent for sketch. */
  value?: number | string;
  /** Offset-only payload; renders the boolean argument and the `.close()` chain. */
  offset?: OffsetEditOptions;
  /** Slot-from-edge payload; renders the trailing `deleteSource` argument. */
  slot?: SlotEditOptions;
  /**
   * Connector-only payload: the name the statement registers, plus the call
   * site of the `part(...)` block whose callback body receives the statement
   * (insertion goes at the end of that body, before a trailing `return`).
   * `anchor` narrows the source to a well-known point (`.center()` etc.);
   * `rotate` / `offset` render the dialog's `.rotate('<axis>', n)` /
   * `.offset(...)` chain after the call.
   */
  connector?: {
    name: string;
    /** The `part(...)` call site whose body receives the statement. */
    part?: { line: number; column: number };
    anchor?: ConnectorAnchor;
    rotate?: { axis: ConnectorRotateAxis; angle: number };
    offset?: [number, number, number];
  };
  /**
   * Expose-only payload: the name the statement registers, plus the call
   * site of the `part(...)` block whose callback body receives the
   * statement — the connector mechanism minus the frame adjustments.
   */
  expose?: {
    name: string;
    /** The `part(...)` call site whose body receives the statement. */
    part?: { line: number; column: number };
  };
  filePath: string;
  producers: {
    line: number;
    column: number;
    featureType: string;
    nameHint: string;
    /**
     * True when the transform must bind this call to a variable. False marks
     * an anchor-only entry: its statement locates the insertion scope for a
     * spec whose parts are all global `select()` expressions.
     */
    bind: boolean;
  }[];
  parts: {
    /** Index into `producers`, or null for a global `select()` part. */
    producer: number | null;
    /** Accessor on the producer's variable, or `select` when producer is null. */
    accessor: string;
    /** Bucket indices to select, or null. */
    indices: number[] | null;
    /** Rendered filter-builder arguments, e.g. `edge().circle(5)`, or null. */
    filterArgs: string | null;
    /**
     * Producers (indices into `producers`) that `filterArgs` references
     * through `{{r<n>}}` tokens — plane-reference selectors like
     * `face().onPlane({{r0}}.endFaces())`. The transform substitutes each
     * token with the bound variable's name.
     */
    refs?: number[] | null;
  }[];
  /** Symbols beyond the feature itself the edit needs imported (`select`, `edge`, `face`). */
  imports: string[];
  /**
   * User-edited replacement for the whole selector argument list (expression
   * transparency). When set, the transform emits it verbatim instead of
   * rendering `parts`, and derives extra imports from its text.
   */
  rawArgs?: string;
  /**
   * Strip every `breakpoint();` after the rewrite — set when an edit dialog
   * applies, clearing the breakpoint it opened with so the model rebuilds to
   * its tip. Mirrors the server transform's flag; the kernel never sets it.
   */
  clearBreakpoints?: boolean;
};

export type ApplyFeatureSynthesis =
  | {
    ok: true;
    spec: ApplyFeatureEditSpec;
    /** Full statement preview, e.g. `fillet(3, e.endEdges())`. */
    preview: string;
    /** The selector argument list alone — what the UI's expression field edits. */
    args: string;
    /** Up to three verified alternative renderings of the argument list. */
    alternatives: string[];
    /**
     * 2D copy only: which producers are the copy's targets (in pick order)
     * and which parts are its per-direction axis edges (in direction order).
     * The route assembles the statement's option payload around these; its
     * absence on a 'copy' synthesis marks a kernel predating the kind.
     */
    copySlots?: { targets: number[]; axisParts: number[] };
  }
  | { ok: false; reason: string; pick?: PickRef };

/**
 * Optional hook giving synthesis the variable names the code transform will
 * actually use (reused `const` bindings, file-collision-free hint names).
 * Called with the bindable producers in spec order; returns one name per
 * producer, null meaning "no better knowledge — allocate a default hint".
 * Implementations must be pure lookups over already-parsed source.
 */
export type ProducerNamer = (producers: {
  line: number;
  column: number;
  featureType: string;
  nameHint: string;
}[]) => (string | null)[];

/**
 * Whether the code transform can bind the producer's statement to a
 * variable. Implementations must be pure lookups over already-parsed source.
 */
export type ProducerBindable = (producer: {
  line: number;
  column: number;
  featureType: string;
}) => boolean;

/**
 * Source-derived context for synthesis, built server-side from the live
 * buffer: `namer` keeps previewed variable names truthful to the transform;
 * `params` are the file's top-level numeric constants, letting dimension
 * constants render as the user's own variables (`onPlane('xy', height)`).
 */
export type SynthesizeOptions = {
  namer?: ProducerNamer;
  /**
   * Statement-level bindability, resolved server-side with the code
   * transform's own statement resolution: false means the transform cannot
   * bind the producer's statement to a variable (its variable is reassigned
   * after the call, a destructuring binding, a nested call) — synthesis must
   * not emit a selector that references it and routes its picks through the
   * variable-free global tier instead. Absent means "assume bindable".
   */
  bindable?: ProducerBindable;
  params?: { name: string; value: number }[];
  /** Connector-only: anchor + dialog adjustments to fold into the statement. */
  connector?: ConnectorSynthesisOptions;
};

/**
 * A well-known point on the connector's picked face or edge — the selection
 * anchor the statement narrows to (`select(...).center()`,
 * `e.startEdges(0).offset('relative', 0.3)`). `start`/`end`/`offset` need an
 * edge pick; `center` works on faces and edges alike.
 */
export type ConnectorAnchor =
  | { kind: 'center' | 'start' | 'end' }
  | { kind: 'offset'; mode: 'relative' | 'absolute'; value: number };

export type ConnectorRotateAxis = 'x' | 'y' | 'z';

/** Dialog adjustments chained after the connector call. */
export type ConnectorSynthesisOptions = {
  anchor?: ConnectorAnchor;
  /** Rotation around one of the connector's local axes, in degrees; skipped when a multiple of 360. */
  rotate?: { axis: ConnectorRotateAxis; angle: number };
  /** Frame-local offset [x, y, z]; skipped when all zero, trailing zeros trimmed. */
  offset?: [number, number, number];
};

/** `.center()` / `.offset('relative', 0.3)` — appended to the source selector. */
export function renderConnectorAnchorSuffix(anchor: ConnectorAnchor | undefined): string {
  if (!anchor) {
    return '';
  }
  if (anchor.kind === 'offset') {
    return `.offset('${anchor.mode}', ${anchor.value})`;
  }
  return `.${anchor.kind}()`;
}

/** `.rotate('x', 90).offset(0, 0, 5)` — chained after the connector call. */
export function renderConnectorAdjustments(
  options: {
    rotate?: { axis: ConnectorRotateAxis; angle: number };
    offset?: [number, number, number];
  } | undefined,
): string {
  if (!options) {
    return '';
  }
  let out = '';
  const rotate = options.rotate;
  if (rotate && Number.isFinite(rotate.angle) && rotate.angle % 360 !== 0) {
    out += `.rotate('${rotate.axis}', ${rotate.angle})`;
  }
  const offset = options.offset;
  if (offset && offset.some(v => v !== 0)) {
    const values = [...offset];
    while (values.length > 1 && values[values.length - 1] === 0) {
      values.pop();
    }
    out += `.offset(${values.join(', ')})`;
  }
  return out;
}

/**
 * Chain-root callees the code transform accepts at a producer's source line.
 * Guards against binding a variable to a wrapper call (e.g. `repeat(...)`)
 * whose line a clone inherited.
 */
export const PRODUCER_CALLEES = [
  'extrude', 'cut', 'revolve', 'sweep', 'loft', 'rib', 'wrap', 'shell',
] as const;

/** Idiomatic variable base name per producer feature type. */
export function nameHintFor(featureType: string): string {
  switch (featureType) {
    case 'extrude': return 'e';
    case 'cut': return 'c';
    case 'revolve': return 'rev';
    case 'sweep': return 'sw';
    case 'loft': return 'lf';
    case 'rib': return 'rib';
    case 'wrap': return 'wr';
    case 'shell': return 'sh';
    case 'plane': return 'p';
    case 'axis': return 'a';
    // 2D sketch geometry (getType values of sketch primitives).
    case 'rect': return 'r';
    case 'line': return 'l';
    case 'arc': return 'a';
    case 'arc-from-center': return 'a';
    case 'tarc': return 'a';
    case 'circle': return 'c';
    case 'ellipse': return 'el';
    case 'polygon': return 'pg';
    case 'slot': return 'sl';
    case 'bezier': return 'bz';
    case 'connect': return 'cn';
    case 'offset': return 'o';
    case 'projection': return 'pj';
    case 'intersect': return 'ix';
    case 'text': return 'tx';
    case 'copy-linear': return 'cp';
    case 'copy-circular': return 'cp';
    default: return 'f';
  }
}
