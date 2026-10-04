// Which callees can produce each kind of feature input (sketches, wires, planes, axes, repeat targets).

import { listEngineSymbols } from '../../lint-fluid-js.ts';

/**
 * Chain-root callees this transform will bind a variable to. Guards against a
 * stale or clone-inherited source line pointing at some unrelated call (e.g.
 * `repeat(...)`): binding `const e = repeat(...)` and emitting `e.endEdges()`
 * would produce broken code, so we refuse instead.
 */
const PRODUCER_CALLEES = new Set([
  'extrude', 'cut', 'revolve', 'sweep', 'loft', 'rib', 'wrap', 'shell', 'hole',
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
 * Chain-root callees a connector input may reference — only the
 * `connector()` statement itself. A copy takes a connector as a target
 * (`copy('circular', 'z', {…}, bolt)`) or as its axis; `repeat` never binds
 * one: its `feature` producers exclude the callee, since repeat() re-applies
 * features and refuses connectors.
 */
const CONNECTOR_CALLEES = new Set(['connector']);

/**
 * Chain-root callees per 2D sketch-geometry feature type (getType values of
 * sketch primitives and derived ops). A sketch-scoped spec's producers are
 * statements inside a sketch body; binding one to a variable and chaining
 * `.edge(...)` on it is valid for exactly these callees. The derived ops
 * (fillet2d & co.) take ownership of the edges they emit, so a pick on one of
 * their edges attributes to their statement.
 */
export const SKETCH_PRODUCER_CALLEES: Record<string, string[]> = {
  line: ['line'],
  circle: ['circle'],
  ellipse: ['ellipse'],
  arc: ['arc'],
  bezier: ['bezier'],
  offset: ['offset'],
  projection: ['project'],
  intersect: ['intersect'],
  text: ['text'],
  fillet2d: ['fillet'],
  // The 2D copies take ownership of their operands' edges, so picks on them
  // attribute to the copy statement (the type collides with the 3D copies,
  // which never produce sketch edges, so the entry is unambiguous here).
  'copy-linear': ['copy'],
  'copy-circular': ['copy'],
};

/** The chain-root callees producers of `featureType` may bind. */
/**
 * Chain-root callees per repeat feature type: a clone's picks bind the
 * `repeat()` statement itself (`r.instance(k).endEdges()`). `mirror` is the
 * `getType()` of both `repeat('mirror', …)` and the `mirror()` builder.
 */
const REPEAT_PRODUCER_CALLEES: Record<string, string[]> = {
  'repeat-linear': ['repeat'],
  'repeat-circular': ['repeat'],
  'repeat-matrix': ['repeat'],
  'mirror': ['repeat', 'mirror'],
};

export function producerCallees(featureType: string): Set<string> {
  if (featureType === 'connector') {
    return CONNECTOR_CALLEES;
  }
  const sketchCallees = SKETCH_PRODUCER_CALLEES[featureType];
  if (sketchCallees) {
    return new Set(sketchCallees);
  }
  const repeatCallees = REPEAT_PRODUCER_CALLEES[featureType];
  if (repeatCallees) {
    return new Set(repeatCallees);
  }
  return featureType === 'feature' ? REPEAT_TARGET_CALLEES : PRODUCER_CALLEES;
}

/**
 * Producer feature types whose source line must hold exactly one of these
 * calls — sketch, plane, axis and wire inputs are referenced by identity, so
 * any other callee at the line means the file is out of sync. A 'wire' input
 * (a sweep path, a loft guide) is either a sketch or a helix. Null falls
 * back to the general `PRODUCER_CALLEES` allowlist.
 */
export function requiredChainRoots(featureType: string): string[] | null {
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
 * Chain-root callees whose call creates or mutates scene state when the
 * declaration is evaluated — referencing such a binding from inside a part
 * would leave its geometry outside the part's scope, so its statement must
 * move along. Value declarations (numbers, `param()`, filter builders like
 * `face()`, helper functions — their bodies run at call time under whatever
 * container is then active) may stay behind.
 */
const FEATURE_ROOT_CALLEES: Set<string> = (() => {
  const out = new Set(
    listEngineSymbols()
      .filter((s) => s.module === 'fluidcad/core')
      .map((s) => s.name),
  );
  out.delete('breakpoint');
  out.delete('param');
  return out;
})();

/** A custom feature a file reaches through one of its imports. */
export type CustomFeatureCallee = {
  /** The feature's id: the `getType()` of the object the call builds. */
  id: string;
  kind: 'tool' | 'modifier';
};

/**
 * What the chain-root callees of one file build: the built-in lists above,
 * plus the custom features the file imports, by the local name each import
 * binds (`import { standoff as so }` makes `so` a standoff). Every closed
 * callee list the code-writing layer consults answers through here, so a
 * custom feature binds, repeats and moves like a built-in:
 * - a call to it produces the inputs its own id names — the pick
 *   attributed to the feature's bucket, and every feature has the bucket
 *   accessors (`s.endFaces()`);
 * - it is a repeat, copy and scope target (`featureType: 'feature'`), as
 *   fillet and draft are among the built-ins;
 * - its statement builds a feature when it evaluates.
 *
 * {@link FeatureCallees.BUILT_IN} is the built-in lists alone, the answer for
 * a file that imports no custom feature or a caller that has no catalog.
 */
export class FeatureCallees {
  static readonly BUILT_IN = new FeatureCallees(new Map());

  /** The source of a caller without a feature catalog: every file has the built-in lists alone. */
  static readonly BUILT_IN_SOURCE: FeatureCalleeSource = {
    calleesFor: async () => FeatureCallees.BUILT_IN,
  };

  constructor(private readonly custom: ReadonlyMap<string, CustomFeatureCallee>) {}

  /** The custom feature a call to `callee` builds, or null for any other callee. */
  feature(callee: string): CustomFeatureCallee | null {
    return this.custom.get(callee) ?? null;
  }

  /**
   * The producer-binding gate: whether the call whose chain root is
   * `callee` may be bound as a producer of `featureType`. Sketch, plane,
   * axis and wire inputs name their own call ({@link requiredChainRoots});
   * everything else takes the callees its type accepts.
   */
  produces(featureType: string, callee: string | null): boolean {
    if (callee === null) {
      return false;
    }
    const required = requiredChainRoots(featureType);
    if (required) {
      return required.includes(callee);
    }
    if (producerCallees(featureType).has(callee)) {
      return true;
    }
    const custom = this.custom.get(callee);
    if (!custom) {
      return false;
    }
    return featureType === 'feature' || custom.id === featureType;
  }

  /** Whether a call to `callee` creates or mutates scene state when its statement evaluates. */
  buildsFeature(callee: string): boolean {
    return FEATURE_ROOT_CALLEES.has(callee) || this.custom.has(callee);
  }

  /** What these callees were built from, as text: a memo key for answers that depend on them. */
  key(): string {
    return JSON.stringify([...this.custom].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** Where a file's {@link FeatureCallees} come from: the feature catalog, or a fixed set in tests. */
export interface FeatureCalleeSource {
  calleesFor(code: string, filePath: string): Promise<FeatureCallees>;
}
