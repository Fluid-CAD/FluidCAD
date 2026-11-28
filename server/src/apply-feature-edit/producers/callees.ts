// Which callees can produce each kind of feature input (sketches, wires, planes, axes, repeat targets).

import { chainRootCallee, type TSNode } from '../../code-editor/index.ts';
import { listEngineSymbols } from '../../lint-fluid-js.ts';
import { decomposeChain } from '../ast/chain.ts';
import type { CustomFeatureShape } from '../features/custom.ts';
import { curveCallees, hasPartTool, placementOf, readsAsCurve } from '../parse/parsed-statement.ts';

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
 * Chain-root callees per curve feature type. A curve binds for its
 * `edges()` bucket (`h.edges(0)`), the first route to a pick on its edge,
 * and has none of the accessors the {@link PRODUCER_CALLEES} share
 * (`endEdges()`, `sideFaces()`), as they have no `edges()`: a helix
 * produces only for a helix, so a stale line that lands on the other kind of
 * call is refused, not bound to an accessor the call does not have. An
 * intersection curve is an `intersect(…)`, a projected curve a `project(…)`
 * and an offset curve an `offset(…, { on })` outside a sketch: inside one
 * the callee is the sketch tool, and an `offset(…)` outside one with no
 * trailing object outlines faces, which {@link FeatureCallees.binds} refuses
 * by the form of the call. A bridge is a `bridge(…)`, which has one form.
 */
const CURVE_PRODUCER_CALLEES: Record<string, string[]> = {
  helix: ['helix'],
  'intersection-curve': ['intersect'],
  'projected-curve': ['project'],
  'offset-curve': ['offset'],
  bridge: ['bridge'],
};

/**
 * Chain-root callees a repeat target may reference — any builder returning a
 * repeatable scene feature. Broader than {@link PRODUCER_CALLEES}: a repeat
 * only binds the call to a variable and passes it along (`repeat(…, f)`), it
 * never chains selector accessors onto it, so modifier and primitive calls
 * qualify too. The move, copy and colour targets take the same list: what
 * they name may hold a surface or a curve rather than a solid — `load()`
 * brings both in from a file, `helix()`, `bridge()`, and `intersect()`,
 * `project()` and `offset(…, { on })` outside a sketch, draw a curve (the
 * callee's other forms are refused by {@link FeatureCallees.binds}).
 */
const REPEAT_TARGET_CALLEES = new Set([
  ...PRODUCER_CALLEES,
  'fillet', 'chamfer', 'draft', 'cylinder', 'sphere', 'helix', 'intersect', 'project', 'offset', 'bridge',
  'fuse', 'subtract', 'common', 'mirror', 'translate', 'rotate',
  'repeat', 'copy', 'load', 'part', 'select',
  // A split holds the pieces it made, so it is the body a later target pick
  // lands on when it is the last feature to touch that body. A colour is
  // not here: `color()` writes face-colour records on the holder of the
  // painted solid and holds nothing itself, so a pick on a painted body
  // attributes to the feature that built it, never to the paint.
  'split',
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
  eArc: ['eArc'],
  bezier: ['bezier'],
  spline: ['spline'],
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

/** The chain-root callees producers of `featureType` may bind. */
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
  const ownCurveCallees = CURVE_PRODUCER_CALLEES[featureType];
  if (ownCurveCallees) {
    return new Set(ownCurveCallees);
  }
  return featureType === 'feature' ? REPEAT_TARGET_CALLEES : PRODUCER_CALLEES;
}

/**
 * Producer feature types whose source line must hold exactly one of these
 * calls — sketch, plane and axis inputs are referenced by identity, so any
 * other callee at the line means the file is out of sync. Null for every
 * other type: a wire or a surface input is decided by what its statement
 * left ({@link FeatureCallees.identityMismatch}), the rest by the callees their
 * type accepts.
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
  return null;
}

/**
 * Whether producers of `featureType` are identity inputs: a statement the
 * consumer names whole, by its variable — a sketch, a plane, an axis, a
 * wire (a sweep path, a loft guide, an edge plane's base) or a surface.
 */
export function namesWholeStatement(featureType: string): boolean {
  return requiredChainRoots(featureType) !== null || featureType === 'wire' || featureType === 'surface';
}

/**
 * What the rendered scene says the statement at a call site left: a curve of
 * its own, a surface (the engine's `Producers`).
 */
export type StatementProduct = { curve: boolean; surface: boolean };

/**
 * The rendered scene's answers about one file's statements. Null where it
 * has none: nothing rendered, a line the scene built nothing at, an engine
 * that predates the question.
 */
export interface StatementProducts {
  at(site: { line: number; column?: number }): StatementProduct | null;
}

/** A producer as the binding gate reads it: its type and its statement's site. */
export type ProducerSite = { featureType?: string; line: number; column?: number };

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
  out.delete('configurations');
  return out;
})();

/** `a sketch() or helix() call`: the calls a refusal expected, by callee. */
function callsNamed(callees: string[]): string {
  return `a ${callees.map(callee => `${callee}()`).join(' or ')} call`;
}

/** A custom feature a file reaches through one of its imports. */
export type CustomFeatureCallee = {
  /** The feature's id: the `getType()` of the object the call builds. */
  id: string;
  kind: 'tool' | 'modifier';
  /**
   * How its statements are laid out (the catalog's snapshot): what the
   * edit dialog reads a call by. Without one the call binds and repeats,
   * but is not editable in a dialog.
   */
  shape?: CustomFeatureShape;
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

  constructor(
    private readonly custom: ReadonlyMap<string, CustomFeatureCallee>,
    private readonly scene: StatementProducts | null = null,
  ) {}

  /**
   * These callees read over the rendered scene: a wire or a surface input
   * may then name any statement the scene holds a curve or a surface of —
   * an imported one, a repeat of one, a tool's result — and not only the
   * calls a file is read as drawing a curve by.
   */
  over(scene: StatementProducts): FeatureCallees {
    return new FeatureCallees(this.custom, scene);
  }

  /** The custom feature a call to `callee` builds, or null for any other callee. */
  feature(callee: string): CustomFeatureCallee | null {
    return this.custom.get(callee) ?? null;
  }

  /**
   * The producer-binding gate by callee: whether the call whose chain root
   * is `callee` may be bound as a producer of `featureType`. Sketch, plane
   * and axis inputs name their own call ({@link requiredChainRoots});
   * everything else takes the callees its type accepts. A wire or a surface
   * input is decided by its statement, not its callee — {@link binds} asks
   * the scene — so here a wire takes the callees a file is read as drawing a
   * curve by, and a surface any feature statement.
   */
  produces(featureType: string, callee: string | null): boolean {
    if (callee === null) {
      return false;
    }
    if (featureType === 'wire') {
      return curveCallees().includes(callee);
    }
    if (featureType === 'surface') {
      return this.produces('feature', callee);
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

  /**
   * The producer-binding gate: whether `call`, the statement at
   * `producer`'s site, may be bound as that producer. A wire input is a
   * statement that left a curve of its own and a surface input one that
   * holds a surface, as the scene answers; every other type is decided by
   * the call's callee ({@link produces}).
   */
  binds(producer: ProducerSite, call: TSNode): boolean {
    if (producer.featureType === 'wire') {
      return this.leftCurve(producer, call);
    }
    if (producer.featureType === 'surface') {
      return this.holdsSurface(producer, call);
    }
    return FeatureCallees.placedFor(producer, call) && this.producesBy(producer.featureType ?? '', call);
  }

  /**
   * Whether `call` is the form of its callee that `producer`'s type names,
   * for a callee that means a sketch tool inside a `sketch(…)` callback and
   * a part-scope tool outside one (`intersect`, `project`, `offset` with
   * `{ on }`): a sketch-geometry producer binds only the call inside, every
   * other producer only the call outside. A stale line that lands on the
   * other form would bind accessors the object it builds does not have.
   * Every other call is the one form its callee names, or a form outside a
   * sketch the part-scope tool does not read ({@link producesBy}).
   */
  private static placedFor(producer: ProducerSite, call: TSNode): boolean {
    const chain = decomposeChain(call);
    const placement = chain ? placementOf(chain, call) : null;
    if (placement === null) {
      return true;
    }
    const sketchGeometry = Object.hasOwn(SKETCH_PRODUCER_CALLEES, producer.featureType ?? '');
    return (placement === 'sketch') === sketchGeometry;
  }

  /**
   * The gate by callee ({@link produces}) for `call`. A callee whose form
   * outside a sketch is a part-scope tool is named in the curve and target
   * lists for that tool alone, so a call of it outside a sketch in a form
   * the tool does not read — an `offset(…)` with no trailing object, the
   * face outline, which builds the sketch tool's class — binds by callee
   * only as sketch geometry, as it did before the tool.
   */
  private producesBy(featureType: string, call: TSNode): boolean {
    const callee = chainRootCallee(call);
    if (callee !== null && !this.custom.has(callee) && hasPartTool(callee)
      && !Object.hasOwn(SKETCH_PRODUCER_CALLEES, featureType)) {
      const chain = decomposeChain(call);
      if (chain && placementOf(chain, call) === null) {
        return false;
      }
    }
    return this.produces(featureType, callee);
  }

  /**
   * What the statement at an identity input's site was expected to be, when
   * `call` is not it — `a sketch() call` — or null when it is, and for a
   * producer that names no identity input. A stale line pointing at some
   * other call would consume the wrong input, so the caller refuses.
   */
  identityMismatch(producer: ProducerSite, call: TSNode): string | null {
    const required = requiredChainRoots(producer.featureType ?? '');
    if (required) {
      const callee = chainRootCallee(call);
      return callee !== null && required.includes(callee) ? null : callsNamed(required);
    }
    if (producer.featureType === 'wire') {
      return this.leftCurve(producer, call) ? null : callsNamed(curveCallees());
    }
    if (producer.featureType === 'surface') {
      return this.holdsSurface(producer, call) ? null : 'a statement that holds a surface';
    }
    return null;
  }

  /**
   * Whether the statement left a curve of its own: by the reading of the
   * call alone (a `sketch()`, a `helix()`), or by the scene's answer for
   * its site.
   */
  private leftCurve(producer: ProducerSite, call: TSNode): boolean {
    return FeatureCallees.placedFor(producer, call)
      && (readsAsCurve(call) || this.scene?.at(producer)?.curve === true);
  }

  /**
   * Whether the statement holds a surface, as the scene answers. Nothing in
   * a call's text tells a surface from a solid, so without an answer any
   * feature statement qualifies, as it does for a repeat target.
   */
  private holdsSurface(producer: ProducerSite, call: TSNode): boolean {
    if (!FeatureCallees.placedFor(producer, call)) {
      return false;
    }
    const product = this.scene?.at(producer) ?? null;
    return product ? product.surface : this.producesBy('feature', call);
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
