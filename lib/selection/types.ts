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
};

export type ExplainResult = {
  picks: PickExplanation[];
};

export type ApplyFeatureKind = 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'sweep' | 'loft' | 'plane';

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
export type ApplyFeatureEditSpec = {
  feature: ApplyFeatureKind;
  /** Numeric parameter (radius/distance/thickness); absent for sketch. */
  value?: number;
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
  }[];
  /** Symbols beyond the feature itself the edit needs imported (`select`, `edge`, `face`). */
  imports: string[];
  /**
   * User-edited replacement for the whole selector argument list (expression
   * transparency). When set, the transform emits it verbatim instead of
   * rendering `parts`, and derives extra imports from its text.
   */
  rawArgs?: string;
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
 * Source-derived context for synthesis, built server-side from the live
 * buffer: `namer` keeps previewed variable names truthful to the transform;
 * `params` are the file's top-level numeric constants, letting dimension
 * constants render as the user's own variables (`onPlane('xy', height)`).
 */
export type SynthesizeOptions = {
  namer?: ProducerNamer;
  params?: { name: string; value: number }[];
};

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
    default: return 'f';
  }
}
