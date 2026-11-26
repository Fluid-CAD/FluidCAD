import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { SceneObject } from "../common/scene-object.js";
import { ISceneObject } from "../core/interfaces.js";
import { Point } from "../math/point.js";
import { Plane, toPlane } from "../math/plane.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeProbe, FaceProbe } from "./probe.js";
import { EdgeProperties } from "../oc/edge-props.js";
import { FaceProperties } from "../oc/face-props.js";
import { FaceQuery } from "../oc/face-query.js";
import { mmTol } from "../units/tolerance.js";
import { Shape } from "../common/shape.js";
import { ShapeMeasure } from "../oc/shape-measure.js";
import { groupLayers } from "../filters/rank/extremal.js";
import { edgeSideDistances } from "../filters/edge/above-below.js";
import { faceSideDistances, faceSideDistancesPastSpan, isJudgedByVertices } from "../filters/face/above-below.js";
import type { BodyKind } from "../filters/body-kind.js";
import { CurveClassifier } from "../oc/curve-classifier.js";
import { Vector3d } from "../math/vector3d.js";

/**
 * One filter predicate candidate: a rendered code fragment plus the builder
 * call that evaluates it. Constants embedded in `addTo` are parsed back from
 * the rendered text, so verification exercises exactly the code that would be
 * written — a constant that doesn't round-trip fails verification and the
 * atom is discarded rather than producing wrong code.
 */
export type Atom<B> = {
  /** Rendered chain fragment, e.g. `.arc(5)` or `.onPlane('xy', 30)`. */
  code: string;
  addTo: (builder: B) => void;
  /** Robustness weight: qualitative > plane-relative > numeric (design §3.2). */
  weight: number;
  /** Number of numeric constants (fewer = more robust to dimension edits). */
  constants: number;
  /**
   * Geometry-valued constants baked into the rendered text — positions,
   * lengths, diameters not linked to a user parameter (absent = 0).
   * Dimension edits silently break these, so a verified bucket-index
   * selector outranks any filter carrying one. Parameter-linked constants
   * never count (the emitted name follows the user's variable), and neither
   * do pure counts like `edgeCount(6)`, which dimension edits cannot break.
   */
  bakedConstants?: number;
  /** True when the predicate only evaluates correctly inside `select()`. */
  needsScope: boolean;
  /**
   * Set-level predicate (`farthest`, `largest`, `nth`…) whose match set
   * depends on the candidates it runs over: induction evaluates it against
   * the conjunction built so far rather than a precomputed universe match.
   */
  contextual?: boolean;
  /**
   * Earliest conjunction position a contextual atom may take. A layer index
   * (`nth`) only reads well inside an already-described family — "the second
   * layer of arcs on the top face" — never as an opener.
   */
  minDepth?: number;
  /**
   * Producer whose variable the rendered code references (plane-reference
   * atoms). The code carries the `{{ref}}` placeholder where the variable
   * name goes; the writer must bind `ref` and substitute its name.
   */
  ref?: SceneObject;
  /**
   * The code passes `ref`'s variable whole — `from({{ref}})` — rather than
   * chaining an accessor on it. Any feature-producing call binds for that
   * use, not only the ones with selector accessors.
   */
  wholeRef?: boolean;
  /**
   * Scope predicate (`from(...)`): it narrows the universe the rest of the
   * conjunction describes rather than describing the picks itself, so it
   * does not count toward the conjunction's readability cap.
   */
  scope?: boolean;
};

export type EdgeAtom = Atom<EdgeFilterBuilder>;
export type FaceAtom = Atom<FaceFilterBuilder>;

/**
 * A user source variable a synthesized constant may link to: when a
 * dimension-like constant equals `value` exactly, the atom's rendered text
 * emits `name` instead of the bare number (`onPlane('xy', height)`), so the
 * selector tracks the user's parameter through future edits. Counts
 * (`edgeCount`) and synthetic gap thresholds (`above`/`below`) never link —
 * a name there would imply provenance the number doesn't have.
 */
export type ParameterLink = { name: string; value: number };

/**
 * A bindable feature's face group, usable as a reference inside a filter:
 * `onPlane(e.endFaces())` / `above(base.endFaces())` instead of a numeric
 * plane offset, or `belongsToFace(boss.sideFaces())` instead of a diameter.
 * The group's recorded faces survive consumption (a bucket accessor resolves
 * its as-built state), so the reference stays valid even when a later
 * feature reshaped or consumed the geometry — and unlike a baked constant it
 * tracks dimension edits. `plane` is what the emitted `onPlane(<var>.<accessor>())`
 * resolves — the first member's surface plane — or null when the members
 * are not one plane; `members` are what `belongsToFace(<var>.<accessor>())`
 * looks edges up in.
 */
export type FaceSource = {
  /** The producer the emitted code binds a variable to (a repeat for a clone's group). */
  feature: SceneObject;
  /** Accessor chain after the variable, e.g. `endFaces` or `instance(1).endFaces`. */
  accessor: string;
  members: Face[];
  plane: Plane | null;
  /** Evaluates the accessor exactly as the emitted `<var>.<accessor>()` would. */
  resolve: () => SceneObject;
};

/**
 * A `from()` scope every pick lives in, named through a bindable producer's
 * variable. Two kinds:
 *
 * - a repeat instance — `select(edge().from(r.instance(1)).circle())` — the
 *   address of a clone the bucket accessors cannot reach: a slot that
 *   repeats several features, or a dependency clone (the extrude behind a
 *   repeated fillet);
 * - the feature owning the picks' solid — `select(edge().from(f).line())` —
 *   the one thing that separates a pick from a geometrically identical twin
 *   on another solid (two touching `.new()` bodies share coincident edges no
 *   geometric predicate can tell apart). Ownership moves with every later
 *   feature that rebuilds the solid, so synthesis only offers it once no
 *   geometric filter resolves (see `synthesizeSelectors`).
 *
 * `accessor` is the chain after the variable (`instance(1)`), or null when
 * the variable itself is the scope; `resolve` is the very object the
 * emitted `from(...)` argument evaluates to.
 */
export type FromSource = {
  feature: SceneObject;
  accessor: string | null;
  resolve: () => SceneObject;
};

/**
 * Format a dimension-like constant, preferring the name of an exactly-equal
 * user parameter. Exact equality (post-rounding) keeps the verification
 * invariant intact: the emitted expression evaluates to the same number the
 * verified builder used.
 */
function linkedConstant(value: number, params: ParameterLink[]): { text: string; value: number; linked: boolean } {
  const c = formatConstant(value);
  const match = params.find(p => p.value === c.value);
  if (match) {
    return { text: match.name, value: c.value, linked: true };
  }
  return { ...c, linked: false };
}

type PrincipalPlane = { name: 'xy' | 'xz' | 'yz'; axis: 'z' | 'y' | 'x' };

const PRINCIPAL_PLANES: PrincipalPlane[] = [
  { name: 'xy', axis: 'z' },
  { name: 'xz', axis: 'y' },
  { name: 'yz', axis: 'x' },
];

/** Coordinate / plane-distance slack: 1e-7 mm, in the active unit. */
function sharedTolerance(): number {
  return mmTol(1e-7);
}
/** The angular half of the coplanar test — unit: dimensionless. */
const SHARED_ANGULAR_TOLERANCE = 1e-7;

/**
 * Sign of the principal plane's normal along its axis (`'xz'` has a −y
 * normal). `onPlane`/`above`/`below` offsets run along the normal, so every
 * axis coordinate must be mapped through this sign to become an offset.
 */
const planeSigns = new Map<string, number>();

function planeNormalSign(plane: PrincipalPlane): number {
  let sign = planeSigns.get(plane.name);
  if (sign === undefined) {
    sign = toPlane(plane.name).normal[plane.axis] >= 0 ? 1 : -1;
    planeSigns.set(plane.name, sign);
  }
  return sign;
}

/**
 * Instantiate candidate edge atoms from the picked edges' geometry. Universe
 * members are only consulted for `above`/`below` threshold placement; atom
 * truth over the universe is established later through the real predicates.
 * `allowScoped` gates the scope-aware atoms (`belongsToFace`, convexity,
 * `ofSolid()` / `ofSurface()`), which need the evaluator's scope injection —
 * `select()` and bucket accessors both provide it. `bodyKinds` are the kinds
 * of body the universe's shapes belong to.
 */
export function instantiateEdgeAtoms(
  probes: EdgeProbe[],
  universe: Edge[],
  allowScoped: boolean,
  params: ParameterLink[] = [],
  faceSources: FaceSource[] = [],
  fromSources: FromSource[] = [],
  bodyKinds: ReadonlySet<BodyKind> = new Set(),
): EdgeAtom[] {
  const atoms: EdgeAtom[] = [];
  atoms.push(...fromAtoms<EdgeFilterBuilder>(fromSources));

  const curveClass = sharedString(probes.map(p => p.props.curveType));
  if (curveClass === 'line') {
    atoms.push({ code: '.line()', addTo: b => b.line(), weight: 30, constants: 0, needsScope: false });
    const length = sharedNumber(probes.map(p => p.props.length));
    if (length !== null) {
      const c = linkedConstant(length, params);
      atoms.push({ code: `.line(${c.text})`, addTo: b => b.line(c.value), weight: 15, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false });
    }
  }
  if (curveClass === 'arc') {
    atoms.push({ code: '.arc()', addTo: b => b.arc(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius, params);
      atoms.push({ code: `.arc(${c.text})`, addTo: b => b.arc(c.value), weight: 15, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false });
    }
  }
  if (curveClass === 'circle') {
    atoms.push({ code: '.circle()', addTo: b => b.circle(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius * 2, params);
      atoms.push({ code: `.circle(${c.text})`, addTo: b => b.circle(c.value), weight: 15, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false });
    }
  }
  if (curveClass === 'ellipse' || curveClass === 'spline') {
    atoms.push({ code: `.${curveClass}()`, addTo: b => b[curveClass](), weight: 30, constants: 0, needsScope: false });
  }
  if (curveClass === null || curveClass === 'ellipse' || curveClass === 'spline' || curveClass === 'other') {
    // No line, arc or circle atom covers these picks (mixed classes, or a
    // fillet transition spline that recovers to no line or circle). A
    // negated class can still separate them: e.g. a rim of arcs plus such
    // splines needs `.notCircle()` to shed a coplanar bore circle.
    atoms.push({ code: '.notLine()', addTo: b => b.notLine(), weight: 28, constants: 0, needsScope: false });
    atoms.push({ code: '.notCircle()', addTo: b => b.notCircle(), weight: 28, constants: 0, needsScope: false });
    atoms.push({ code: '.notArc()', addTo: b => b.notArc(), weight: 28, constants: 0, needsScope: false });
  }

  atoms.push(...closedAtoms(probes, universe));
  if (curveClass === 'spline' || curveClass === 'other') {
    const planar = sharedBoolean(probes.map(p => p.props.planar));
    if (planar !== null) {
      atoms.push({
        code: planar ? '.planar()' : '.notPlanar()',
        addTo: b => planar ? b.planar() : b.notPlanar(),
        weight: 25, constants: 0, needsScope: false,
      });
    }
  }

  // Only a straight edge is ever perpendicular to a plane: `verticalTo` is
  // false for every curve that is no line, circle or arc.
  const chordJudged = probes.every(p => p.lineOrCircular);
  for (const plane of PRINCIPAL_PLANES) {
    atoms.push({
      code: `.parallelTo('${plane.name}')`,
      addTo: b => b.parallelTo(plane.name),
      weight: 25, constants: 0, needsScope: false,
    });
    if (chordJudged) {
      atoms.push({
        code: `.verticalTo('${plane.name}')`,
        addTo: b => b.verticalTo(plane.name),
        weight: 25, constants: 0, needsScope: false,
      });
    }

    const coords = probes.flatMap(p => [...p.ends, p.mid]).map(pt => pt[plane.axis]);
    const shared = sharedNumber(coords);
    if (shared !== null) {
      atoms.push(onPlaneAtom<EdgeFilterBuilder>(plane, shared, params, (b, offset) =>
        offset === 0 ? b.onPlane(plane.name) : b.onPlane(plane.name, offset)));
    }
  }

  atoms.push(...planeRefAtoms<EdgeFilterBuilder>(
    probes.flatMap(p => [...p.ends, p.mid]), faceSources,
  ));
  atoms.push(...faceRefAtoms(probes, faceSources));

  atoms.push(...rankAtoms<EdgeFilterBuilder>(probes, universe));

  atoms.push(...thresholdAtoms<EdgeFilterBuilder, Edge>(
    plane => probes.flatMap(p => edgeSideDistances(p.edge, plane)), universe, edgeSideDistances,
    (b, plane, offset) => offset === 0 ? b.above(plane) : b.above(plane, offset),
    (b, plane, offset) => offset === 0 ? b.below(plane) : b.below(plane, offset)));

  if (allowScoped) {
    atoms.push(...convexityAtoms(probes));
    atoms.push(...belongsToFaceAtoms(probes, params));
    atoms.push(...wireRefAtoms(probes, faceSources));
    atoms.push(...bodyKindAtoms<EdgeFilterBuilder>(probes, bodyKinds));
  }

  return atoms;
}

/** The curve kinds whose class leaves open whether the edge returns to its start. */
const CLOSABLE_CURVE_TYPES: ReadonlySet<EdgeProperties['curveType']> = new Set(['ellipse', 'spline', 'other']);

/**
 * `closed()` / `open()` — whether the picked curves return to their start
 * (a full ellipse, a closed spline), offered when the picks agree, the
 * universe holds both, and a pick is an ellipse, a spline or another curve.
 * A line, an arc and a circle say it by their class already, so picks of
 * those alone get neither: `circle()` names a rim as it always has.
 */
function closedAtoms(probes: EdgeProbe[], universe: Edge[]): EdgeAtom[] {
  const closed = sharedBoolean(probes.map(p => p.props.closed));
  if (closed === null || !probes.some(p => CLOSABLE_CURVE_TYPES.has(p.props.curveType))
    || universe.every(e => CurveClassifier.classify(e).closed === closed)) {
    return [];
  }
  return [{
    code: closed ? '.closed()' : '.open()',
    addTo: b => closed ? b.closed() : b.open(),
    weight: 27, constants: 0, needsScope: false,
  }];
}

/**
 * `ofSolid()` / `ofSurface()` — the kind of body every pick belongs to,
 * offered when the universe holds both kinds: the one thing that separates
 * a surface's faces and edges from a solid's beside it. Scope-aware: the
 * predicate looks the owning body up among the bodies in scope.
 */
function bodyKindAtoms<B extends { ofSolid(): unknown; ofSurface(): unknown }>(
  probes: { bodyKind: BodyKind | null }[],
  bodyKinds: ReadonlySet<BodyKind>,
): Atom<B>[] {
  const kind = sharedString(probes.map(p => p.bodyKind ?? undefined));
  if (kind === null || !bodyKinds.has('solid') || !bodyKinds.has('surface')) {
    return [];
  }
  return [{
    code: kind === 'solid' ? '.ofSolid()' : '.ofSurface()',
    addTo: b => kind === 'solid' ? b.ofSolid() : b.ofSurface(),
    weight: 24, constants: 0, needsScope: true,
  }];
}

/**
 * `convex()` / `concave()` / `smooth()` — the qualitative corner class the
 * picks share within their owning solid. Scope-dependent (the predicate
 * looks up the edge's two faces), constant-free, and the most descriptive
 * predicate a fillet or chamfer pick usually has: "the inner corners" beats
 * any plane the junction happens to sit on.
 */
function convexityAtoms(probes: EdgeProbe[]): EdgeAtom[] {
  const convexity = sharedString(probes.map(p => p.convexity ?? undefined));
  if (convexity === null) {
    return [];
  }
  return [{
    code: `.${convexity}()`,
    addTo: b => b[convexity](),
    weight: 26, constants: 0, needsScope: true,
  }];
}

/**
 * Instantiate candidate face atoms from the picked faces' geometry, as
 * {@link instantiateEdgeAtoms} does for edges. `bodyKinds` are the kinds of
 * body the universe's faces belong to.
 */
export function instantiateFaceAtoms(
  probes: FaceProbe[],
  universe: Face[],
  params: ParameterLink[] = [],
  faceSources: FaceSource[] = [],
  fromSources: FromSource[] = [],
  bodyKinds: ReadonlySet<BodyKind> = new Set(),
): FaceAtom[] {
  const atoms: FaceAtom[] = [];
  atoms.push(...fromAtoms<FaceFilterBuilder>(fromSources));

  const surfaceClass = sharedString(probes.map(p => p.props.surfaceType));
  if (surfaceClass === 'plane') {
    atoms.push({ code: '.planar()', addTo: b => b.planar(), weight: 30, constants: 0, needsScope: false });
  }
  if (surfaceClass === 'cylinder') {
    // A full wrap answers to `cylinder()`, a partial one (rounded corner,
    // fillet, slotted bore) to `cylinderCurve()` — the atom must be the
    // filter that admits the picks, or verification drops it. A pick set
    // mixing the two has no positive class and keeps only what it is not.
    const name = sharedString(probes.map(p => cylinderFilterName(p.props)));
    if (name !== null) {
      atoms.push({ code: `.${name}()`, addTo: b => b[name](), weight: 30, constants: 0, needsScope: false });
      const radius = sharedNumber(probes.map(p => p.props.radius));
      if (radius !== null) {
        const c = linkedConstant(radius * 2, params);
        atoms.push({ code: `.${name}(${c.text})`, addTo: b => b[name](c.value), weight: 15, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false });
      }
    }
    else {
      atoms.push({ code: '.notPlanar()', addTo: b => b.notPlanar(), weight: 28, constants: 0, needsScope: false });
      atoms.push({ code: '.notCircle()', addTo: b => b.notCircle(), weight: 28, constants: 0, needsScope: false });
    }
  }
  if (surfaceClass === 'circle') {
    atoms.push({ code: '.circle()', addTo: b => b.circle(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius * 2, params);
      atoms.push({ code: `.circle(${c.text})`, addTo: b => b.circle(c.value), weight: 15, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false });
    }
  }
  if (surfaceClass === 'cone') {
    atoms.push({ code: '.cone()', addTo: b => b.cone(), weight: 30, constants: 0, needsScope: false });
  }
  if (surfaceClass === 'sphere') {
    atoms.push({ code: '.sphere()', addTo: b => b.sphere(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius * 2, params);
      atoms.push({ code: `.sphere(${c.text})`, addTo: b => b.sphere(c.value), weight: 15, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false });
    }
  }
  if (surfaceClass === 'freeform' || surfaceClass === 'revolved' || surfaceClass === 'extruded') {
    atoms.push({ code: `.${surfaceClass}()`, addTo: b => b[surfaceClass](), weight: 30, constants: 0, needsScope: false });
  }
  if (surfaceClass === null || !ELEMENTARY_FACE_TYPES.has(surfaceClass)) {
    // Same rationale as the negated edge classes: picks with no plane,
    // cylinder or circle atom (mixed classes, or a sphere, revolved,
    // extruded or free-form face) can still be separated from a same-plane
    // intruder by what they are not.
    atoms.push({ code: '.notPlanar()', addTo: b => b.notPlanar(), weight: 28, constants: 0, needsScope: false });
    atoms.push({ code: '.notCylinder()', addTo: b => b.notCylinder(), weight: 28, constants: 0, needsScope: false });
    atoms.push({ code: '.notCircle()', addTo: b => b.notCircle(), weight: 28, constants: 0, needsScope: false });
  }
  if (surfaceClass === 'torus') {
    atoms.push({ code: '.torus()', addTo: b => b.torus(), weight: 30, constants: 0, needsScope: false });
    const major = sharedNumber(probes.map(p => p.props.majorRadius));
    const minor = sharedNumber(probes.map(p => p.props.minorRadius));
    if (major !== null && minor !== null) {
      const a = linkedConstant(major, params);
      const b2 = linkedConstant(minor, params);
      atoms.push({
        code: `.torus(${a.text}, ${b2.text})`,
        addTo: b => b.torus(a.value, b2.value),
        weight: 15, constants: 2,
        bakedConstants: (a.linked ? 0 : 1) + (b2.linked ? 0 : 1),
        needsScope: false,
      });
    }
  }

  for (const plane of PRINCIPAL_PLANES) {
    atoms.push({
      code: `.parallelTo('${plane.name}')`,
      addTo: b => b.parallelTo(plane.name),
      weight: 25, constants: 0, needsScope: false,
    });

    const coords = probes.flatMap(p => p.points).map(pt => pt[plane.axis]);
    const shared = sharedNumber(coords);
    if (shared !== null) {
      atoms.push(onPlaneAtom<FaceFilterBuilder>(plane, shared, params, (b, offset) =>
        offset === 0 ? b.onPlane(plane.name) : b.onPlane(plane.name, offset)));
    }
  }

  atoms.push(...facingAtoms(probes));
  atoms.push(...bodyKindAtoms<FaceFilterBuilder>(probes, bodyKinds));

  const edgeCount = sharedNumber(probes.map(p => p.edgeCount));
  if (edgeCount !== null) {
    atoms.push({
      code: `.edgeCount(${edgeCount})`,
      addTo: b => b.edgeCount(edgeCount),
      weight: 12, constants: 1, needsScope: false,
    });
  }

  if (probes.every(p => p.edgeProps.some(e => e.curveType === 'circle'))) {
    atoms.push({
      code: '.hasEdge(edge().circle())',
      addTo: b => b.hasEdge(new EdgeFilterBuilder().circle()),
      weight: 16, constants: 0, needsScope: false,
    });
    const diameterSets = probes.map(p => new Set(
      p.edgeProps
        .filter(e => e.curveType === 'circle' && e.radius !== undefined)
        .map(e => formatConstant(e.radius! * 2).text),
    ));
    for (const text of sharedMembers(diameterSets).slice(0, 2)) {
      const value = Number(text);
      const c = linkedConstant(value, params);
      atoms.push({
        code: `.hasEdge(edge().circle(${c.text}))`,
        addTo: b => b.hasEdge(new EdgeFilterBuilder().circle(value)),
        weight: 12, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false,
      });
    }
  }

  atoms.push(...planeRefAtoms<FaceFilterBuilder>(probes.flatMap(p => p.points), faceSources));

  atoms.push(...rankAtoms<FaceFilterBuilder>(probes, universe));

  atoms.push(...thresholdAtoms<FaceFilterBuilder, Face>(
    plane => probes.flatMap(p => pickedFaceDistances(p, plane)), universe, faceSideDistancesPastSpan,
    (b, plane, offset) => offset === 0 ? b.above(plane) : b.above(plane, offset),
    (b, plane, offset) => offset === 0 ? b.below(plane) : b.below(plane, offset)));

  return atoms;
}

type PrincipalDirection = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

const PRINCIPAL_DIRECTIONS: { name: PrincipalDirection; vector: Vector3d }[] = [
  { name: 'z', vector: new Vector3d(0, 0, 1) },
  { name: '-z', vector: new Vector3d(0, 0, -1) },
  { name: 'x', vector: new Vector3d(1, 0, 0) },
  { name: '-x', vector: new Vector3d(-1, 0, 0) },
  { name: 'y', vector: new Vector3d(0, 1, 0) },
  { name: '-y', vector: new Vector3d(0, -1, 0) },
];

/**
 * How far a picked face's mean normal may lean from a principal direction
 * for `facing()` to be offered: 20°, well inside the 45° the predicate
 * allows by default, so the written filter keeps holding after small edits.
 */
const FACING_OFFER_DEGREES = 20;

/** The face kinds no class atom places: before `facing()` nothing said "the top one" of these. */
const FACING_FACE_TYPES: ReadonlySet<FaceProperties['surfaceType']> = new Set(['freeform', 'revolved', 'extruded']);

/**
 * `facing('z')` … `facing('-y')` — the principal direction every picked
 * face's mean normal points within {@link FACING_OFFER_DEGREES} of. The
 * qualitative way to name the top of a free-form shape, so it is offered
 * only when a pick is a free-form, revolved or extruded face. Picks on
 * planes, cylinders, cones, spheres and tori get none: their own atoms
 * (`onPlane`, `above`, `farthest`, the classes) name them more tightly,
 * where `facing()` would widen to every face tilted within its angle and,
 * closing a conjunction first, change the code an ordinary solid's picks
 * have always written.
 */
function facingAtoms(probes: FaceProbe[]): FaceAtom[] {
  if (probes.length === 0 || probes.some(p => p.meanNormal === null)) {
    return [];
  }
  if (!probes.some(p => FACING_FACE_TYPES.has(p.props.surfaceType))) {
    return [];
  }
  const cosine = Math.cos((FACING_OFFER_DEGREES * Math.PI) / 180);
  const direction = PRINCIPAL_DIRECTIONS.find(d =>
    probes.every(p => p.meanNormal!.normalize().dot(d.vector) >= cosine));
  if (!direction) {
    return [];
  }
  return [{
    code: `.facing('${direction.name}')`,
    addTo: b => b.facing(direction.name),
    weight: 23, constants: 0, needsScope: false,
  }];
}

/**
 * `belongsToFace(face()...)` atoms from the picked edges' adjacent faces.
 * Scope-dependent: only valid inside a `select()`.
 */
function belongsToFaceAtoms(probes: EdgeProbe[], params: ParameterLink[]): EdgeAtom[] {
  const atoms: EdgeAtom[] = [];
  if (probes.some(p => p.adjacentFaces.length === 0)) {
    return atoms;
  }

  // Full and partial cylinders are different filters; an edge between a bore
  // and a fillet satisfies both, so each is offered on its own evidence.
  for (const name of CYLINDER_FILTERS) {
    const adjacent = (p: EdgeProbe) => p.adjacentFaces.filter(f => cylinderFilterName(f) === name);
    if (!probes.every(p => adjacent(p).length > 0)) {
      continue;
    }
    atoms.push({
      code: `.belongsToFace(face().${name}())`,
      addTo: b => b.belongsToFace(new FaceFilterBuilder()[name]()),
      weight: 18, constants: 0, needsScope: true,
    });
    const diameterSets = probes.map(p => new Set(
      adjacent(p)
        .filter(f => f.radius !== undefined)
        .map(f => formatConstant(f.radius! * 2).text),
    ));
    for (const text of sharedMembers(diameterSets).slice(0, 2)) {
      const value = Number(text);
      const c = linkedConstant(value, params);
      atoms.push({
        code: `.belongsToFace(face().${name}(${c.text}))`,
        addTo: b => b.belongsToFace(new FaceFilterBuilder()[name](value)),
        weight: 14, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: true,
      });
    }
  }
  if (probes.every(p => p.adjacentFaces.some(f => f.surfaceType === 'cone'))) {
    atoms.push({
      code: '.belongsToFace(face().cone())',
      addTo: b => b.belongsToFace(new FaceFilterBuilder().cone()),
      weight: 18, constants: 0, needsScope: true,
    });
  }
  if (probes.every(p => p.adjacentFaces.some(f => f.surfaceType === 'torus'))) {
    atoms.push({
      code: '.belongsToFace(face().torus())',
      addTo: b => b.belongsToFace(new FaceFilterBuilder().torus()),
      weight: 18, constants: 0, needsScope: true,
    });
  }
  for (const kind of ['sphere', 'freeform'] as const) {
    if (probes.every(p => p.adjacentFaces.some(f => f.surfaceType === kind))) {
      atoms.push({
        code: `.belongsToFace(face().${kind}())`,
        addTo: b => b.belongsToFace(new FaceFilterBuilder()[kind]()),
        weight: 18, constants: 0, needsScope: true,
      });
    }
  }
  if (probes.every(p => p.adjacentFaces.some(f => f.surfaceType === 'plane'))) {
    atoms.push({
      code: '.belongsToFace(face().planar())',
      addTo: b => b.belongsToFace(new FaceFilterBuilder().planar()),
      weight: 8, constants: 0, needsScope: true,
    });
  }

  return atoms;
}

/**
 * Plane-reference atoms over a feature's planar face group. When every
 * picked point lies on the plane, `.onPlane({{ref}}.endFaces())` selects the
 * same shapes without baking the offset in; when every point lies strictly
 * on one side, `.above({{ref}}.endFaces())` / `.below(...)` name the
 * half-space the same way — a dimension edit moves the reference plane along
 * with the geometry. Weight sits above every constant-bearing predicate
 * (`onPlane(P, 25)` at 20) but below the exact datum planes (`onPlane('xy')`
 * at 22): a standard plane needs no variable to stay true. Coplanar
 * duplicate sources collapse to the first (buckets scan latest-feature-first,
 * mirroring attribution's preference).
 */
function planeRefAtoms<B extends { onPlane(plane: Plane): unknown; above(plane: Plane): unknown; below(plane: Plane): unknown }>(
  points: Point[],
  sources: FaceSource[],
): Atom<B>[] {
  const atoms: Atom<B>[] = [];
  const seen: Plane[] = [];
  for (const source of sources) {
    const plane = source.plane;
    if (!plane) {
      continue;
    }
    if (seen.some(p => p.isCoplanarWith(plane, sharedTolerance(), SHARED_ANGULAR_TOLERANCE))) {
      continue;
    }
    const distances = points.map(pt => plane.signedDistanceToPoint(pt));
    const tol = sharedTolerance();
    if (distances.every(d => Math.abs(d) <= tol)) {
      seen.push(plane);
      atoms.push({
        code: `.onPlane({{ref}}.${source.accessor}())`,
        addTo: b => b.onPlane(plane),
        weight: 21, constants: 0, needsScope: false,
        ref: source.feature,
      });
    } else if (distances.every(d => d > tol)) {
      seen.push(plane);
      atoms.push({
        code: `.above({{ref}}.${source.accessor}())`,
        addTo: b => b.above(plane),
        weight: 21, constants: 0, needsScope: false,
        ref: source.feature,
      });
    } else if (distances.every(d => d < -tol)) {
      seen.push(plane);
      atoms.push({
        code: `.below({{ref}}.${source.accessor}())`,
        addTo: b => b.below(plane),
        weight: 21, constants: 0, needsScope: false,
        ref: source.feature,
      });
    }
  }
  return atoms;
}

/**
 * `from({{ref}}.instance(k))` / `from({{ref}})` atoms: the repeat instance or
 * owning feature every pick lives on, as a scope. Constant-free and stronger
 * than any plane reference — it names the scope outright, so the rest of the
 * conjunction only has to describe the picks within it.
 */
function fromAtoms<B extends { from(...objects: ISceneObject[]): unknown }>(
  sources: FromSource[],
): Atom<B>[] {
  return sources.map(source => ({
    code: source.accessor === null ? '.from({{ref}})' : `.from({{ref}}.${source.accessor})`,
    addTo: b => b.from(source.resolve() as unknown as ISceneObject),
    weight: 24, constants: 0, needsScope: false,
    ref: source.feature,
    wholeRef: source.accessor === null,
    scope: true,
  }));
}

/**
 * `belongsToFace({{ref}}.sideFaces())` atoms: a feature's face group every
 * picked edge bounds. Two of them name a junction ring by its two families
 * ("the edges where the boss's side meets the base's top") with no constant
 * at all. Whether a group's recorded faces still bound the final edge after
 * later booleans is exactly what verification decides.
 */
function faceRefAtoms(probes: EdgeProbe[], sources: FaceSource[]): EdgeAtom[] {
  const atoms: EdgeAtom[] = [];
  for (const source of sources) {
    const bounded = probes.every(p =>
      source.members.some(face => face.hasEdge(p.edge.getShape()) !== null));
    if (!bounded) {
      continue;
    }
    // Evaluate through the very accessor object the emitted code names —
    // the lazy selection resolves the recorded group on demand.
    atoms.push({
      code: `.belongsToFace({{ref}}.${source.accessor}())`,
      addTo: b => b.belongsToFace(source.resolve()),
      weight: 20, constants: 0, needsScope: false,
      ref: source.feature,
    });
  }
  return atoms;
}

/**
 * `outerOf({{ref}}.endFaces())` / `holeOf({{ref}}.endFaces())` atoms: the
 * loop of a feature's face every picked edge lies on. The loop is read off
 * the pick's *current* owning face that shares the group's surface — the
 * as-built group no longer bounds a rim two fillets reshaped, which is the
 * very case a loop predicate exists for. Constant-free, it ranks just above
 * the face group it refines (20) and just below the plane reference (21):
 * induction takes the atom that isolates more, weight only breaking ties,
 * so the loop wins wherever a plane leaves a bore rim or an inner loop in
 * (it closes the cover, or eliminates more) and the plainer `onPlane(...)`
 * keeps a box rim or a lone corner arc, where both isolate equally.
 */
function wireRefAtoms(probes: EdgeProbe[], sources: FaceSource[]): EdgeAtom[] {
  const atoms: EdgeAtom[] = [];
  for (const source of sources) {
    const roles = probes.map(p => {
      const owner = p.owningFaces.find(face =>
        source.members.some(m => m.compareTo(face) || FaceQuery.isSameSurface(face, m)));
      return owner ? owner.wireRoleOf(p.edge.getShape()) ?? undefined : undefined;
    });
    const role = sharedString(roles);
    if (role === null) {
      continue;
    }
    const method = role === 'outer' ? 'outerOf' : 'holeOf';
    atoms.push({
      code: `.${method}({{ref}}.${source.accessor}())`,
      addTo: b => b[method](source.resolve()),
      weight: 20.5, constants: 0, needsScope: true,
      ref: source.feature,
    });
  }
  return atoms;
}

/** `onPlane` atom whose offset runs along the plane normal, not the raw axis. */
function onPlaneAtom<B>(
  plane: PrincipalPlane,
  axisCoordinate: number,
  params: ParameterLink[],
  addTo: (b: B, offset: number) => unknown,
): Atom<B> {
  const offset = planeNormalSign(plane) * axisCoordinate;
  if (Math.abs(offset) <= sharedTolerance()) {
    return {
      code: `.onPlane('${plane.name}')`,
      addTo: b => addTo(b, 0),
      weight: 22, constants: 0, needsScope: false,
    };
  }
  const c = linkedConstant(offset, params);
  return {
    code: `.onPlane('${plane.name}', ${c.text})`,
    addTo: b => addTo(b, c.value),
    weight: 20, constants: 1, bakedConstants: c.linked ? 0 : 1, needsScope: false,
  };
}

type RankProbe = { center: Point; size: number; props: { radius?: number } };

type RankBuilder = {
  farthest(direction: 'x' | 'y' | 'z'): unknown;
  nearest(direction: 'x' | 'y' | 'z'): unknown;
  nth(direction: 'x' | 'y' | 'z', index: number): unknown;
  largest(measure?: 'size' | 'radius'): unknown;
  smallest(measure?: 'size' | 'radius'): unknown;
};

/** Two centers this close along an axis share a rank layer (mirrors the filter). */
function rankLayerTolerance(): number {
  return mmTol(1e-4);
}

/**
 * Rank atoms: the set-level predicates that replace a numeric cut with a
 * relation to the rest of the candidates. `farthest`/`nearest` per world
 * axis when the picks share a center layer along it; `nth` when that layer
 * is interior over the universe (the ends are the extremes' job); `largest`/
 * `smallest` when the picks share a size (or radius) that is the universe's
 * extreme. All are contextual — their truth depends on what the conjunction
 * already narrowed the candidates to — and constant-free, so they join the
 * robust pass and outrank every gap cut. `nth`'s index is a count, not a
 * geometry constant, but a layer number is less self-evident than an extreme,
 * so it ranks last among them.
 */
function rankAtoms<B extends RankBuilder>(probes: RankProbe[], universe: Shape[]): Atom<B>[] {
  const atoms: Atom<B>[] = [];
  if (probes.length === 0) {
    return atoms;
  }
  const universeCenters = universe.map(shape => ShapeMeasure.centerOfMass(shape));

  for (const axis of ['x', 'y', 'z'] as const) {
    const shared = sharedNumber(probes.map(p => p.center[axis]));
    if (shared === null) {
      continue;
    }
    atoms.push({
      code: `.farthest('${axis}')`, addTo: b => b.farthest(axis),
      weight: 19, constants: 0, needsScope: false, contextual: true,
    });
    atoms.push({
      code: `.nearest('${axis}')`, addTo: b => b.nearest(axis),
      weight: 19, constants: 0, needsScope: false, contextual: true,
    });

    // Interior layers: which index the picks' layer gets depends on what the
    // conjunction has narrowed the candidates to, so every plausible index
    // is offered (bounded by the universe's layer count) and the contextual
    // evaluation keeps the ones that hold. Smaller indices read better —
    // `nth('z', 1)` over `nth('z', -3)` — so they rank slightly higher; 0
    // and -1 are `nearest`/`farthest`'s job.
    const measures = universeCenters.map(c => c[axis]);
    const layerCount = Math.max(...groupLayers(measures, rankLayerTolerance())) + 1;
    const maxIndex = Math.min(layerCount - 2, 6);
    for (let k = 1; k <= maxIndex; k++) {
      for (const index of [k, -k - 1]) {
        atoms.push({
          code: `.nth('${axis}', ${index})`, addTo: b => b.nth(axis, index),
          weight: 14 - k * 0.1, constants: 0, needsScope: false, contextual: true, minDepth: 1,
        });
      }
    }
  }

  const size = sharedNumber(probes.map(p => p.size));
  if (size !== null) {
    const sizes = universe.map(shape => ShapeMeasure.size(shape));
    const sizeTol = Math.max(size * 1e-6, sharedTolerance());
    if (sizes.every(v => v <= size + sizeTol)) {
      atoms.push({
        code: '.largest()', addTo: b => b.largest(),
        weight: 18, constants: 0, needsScope: false, contextual: true,
      });
    }
    if (sizes.every(v => v >= size - sizeTol)) {
      atoms.push({
        code: '.smallest()', addTo: b => b.smallest(),
        weight: 18, constants: 0, needsScope: false, contextual: true,
      });
    }
  }

  const radius = sharedNumber(probes.map(p => p.props.radius));
  if (radius !== null) {
    const radii = universe.map(shape => ShapeMeasure.radius(shape)).filter((r): r is number => r !== null);
    const radiusTol = Math.max(radius * 1e-6, sharedTolerance());
    if (radii.every(r => r <= radius + radiusTol)) {
      atoms.push({
        code: ".largest('radius')", addTo: b => b.largest('radius'),
        weight: 17, constants: 0, needsScope: false, contextual: true,
      });
    }
    if (radii.every(r => r >= radius - radiusTol)) {
      atoms.push({
        code: ".smallest('radius')", addTo: b => b.smallest('radius'),
        weight: 17, constants: 0, needsScope: false, contextual: true,
      });
    }
  }

  return atoms;
}

/**
 * `above`/`below` threshold atoms per principal plane. The threshold is a
 * "nice" number placed in the gap between the picked shapes' extent and the
 * nearest universe shape beyond it — the classic decision-stump cut, and the
 * separator that distinguishes repeat instances from their twins. All cuts
 * are computed in normal-signed distances from the principal plane:
 * `above(P, o)` keeps shapes whose distances along P's normal all exceed
 * `o`. The picks' span comes from `targetDistances`; a universe shape is
 * read by `distancesPastSpan` — the distances the predicates judge its side
 * by (end vertices, or a curved shape's extent), or cheaper stand-ins that
 * lie on the same side of the picks' span and no farther from it.
 *
 * A cut that lands exactly at 0 is not a synthetic gap number but the datum
 * plane itself: the picks straddle a principal plane, and the rendered form
 * (`below('xz')`) carries no constant to go stale when dimensions change. Those
 * atoms outrank every constant-bearing predicate — `onPlane(P, o)` at weight 20
 * most importantly — while still deferring to the exact-plane and qualitative
 * forms. Synthetic mid-gap cuts keep the low threshold weight.
 */
function thresholdAtoms<B, S extends Shape>(
  targetDistances: (plane: Plane) => number[],
  universe: S[],
  distancesPastSpan: (shape: S, plane: Plane, lo: number, hi: number) => number[],
  above: (b: B, plane: 'xy' | 'xz' | 'yz', offset: number) => unknown,
  below: (b: B, plane: 'xy' | 'xz' | 'yz', offset: number) => unknown,
): Atom<B>[] {
  const atoms: Atom<B>[] = [];
  for (const plane of PRINCIPAL_PLANES) {
    const datum = toPlane(plane.name);
    const targetCoords = targetDistances(datum);
    const targetLo = Math.min(...targetCoords);
    const targetHi = Math.max(...targetCoords);
    const universeCoords = universe.flatMap(shape =>
      distancesPastSpan(shape, datum, targetLo - sharedTolerance(), targetHi + sharedTolerance()));

    const beyondLo = universeCoords.filter(v => v < targetLo - sharedTolerance());
    if (beyondLo.length > 0) {
      const cut = niceValueInGap(Math.max(...beyondLo), targetLo);
      if (cut !== null) {
        const c = formatConstant(cut);
        atoms.push({
          code: c.value === 0 ? `.above('${plane.name}')` : `.above('${plane.name}', ${c.text})`,
          addTo: b => above(b, plane.name, c.value),
          weight: c.value === 0 ? 21 : 10,
          constants: c.value === 0 ? 0 : 1,
          bakedConstants: c.value === 0 ? 0 : 1,
          needsScope: false,
        });
      }
    }

    const beyondHi = universeCoords.filter(v => v > targetHi + sharedTolerance());
    if (beyondHi.length > 0) {
      const cut = niceValueInGap(targetHi, Math.min(...beyondHi));
      if (cut !== null) {
        const c = formatConstant(cut);
        atoms.push({
          code: c.value === 0 ? `.below('${plane.name}')` : `.below('${plane.name}', ${c.text})`,
          addTo: b => below(b, plane.name, c.value),
          weight: c.value === 0 ? 21 : 10,
          constants: c.value === 0 ? 0 : 1,
          bakedConstants: c.value === 0 ? 0 : 1,
          needsScope: false,
        });
      }
    }
  }
  return atoms;
}

/**
 * The distances from `plane` a picked face's `above` / `below` cuts are
 * placed clear of. A face judged by its extent spans exactly that. A face
 * judged by its boundary vertices can bulge past them — a half-round pocket
 * end past its two straight edges — so its boundary edges' midpoints count
 * too: a cut then falls beyond the bulge where the vertices alone would
 * let it pass through the picked face.
 */
function pickedFaceDistances(probe: FaceProbe, plane: Plane): number[] {
  return isJudgedByVertices(probe.face)
    ? probe.points.map(point => plane.signedDistanceToPoint(point))
    : faceSideDistances(probe.face, plane);
}

/**
 * Shortest decimal representation that stays within the filter predicates'
 * exact-match tolerance (`Precision.Confusion()` = 1e-7) of the true value.
 */
export function formatConstant(value: number): { text: string; value: number } {
  for (let digits = 0; digits <= 6; digits++) {
    const rounded = Number(value.toFixed(digits));
    if (Math.abs(rounded - value) <= 5e-8) {
      return { text: String(rounded), value: rounded };
    }
  }
  return { text: String(value), value };
}

/** The roundest number strictly inside the open interval (lo, hi). */
export function niceValueInGap(lo: number, hi: number): number | null {
  if (!(hi > lo + sharedTolerance() * 2)) {
    return null;
  }
  const epsilon = Math.min(mmTol(1e-6), (hi - lo) / 100);
  const innerLo = lo + epsilon;
  const innerHi = hi - epsilon;
  const mid = (innerLo + innerHi) / 2;
  for (let power = 3; power >= -6; power--) {
    const step = Math.pow(10, power);
    const decimals = Math.max(0, -power);
    let candidate = Number((Math.round(mid / step) * step).toFixed(decimals));
    if (candidate > innerLo && candidate < innerHi) {
      return candidate;
    }
    candidate = Number((Math.ceil(innerLo / step) * step).toFixed(decimals));
    if (candidate > innerLo && candidate < innerHi) {
      return candidate;
    }
  }
  return mid;
}

/** The face types the negated face classes are not offered for: a plane, a cylinder, a cone, a torus, a round flat face. */
const ELEMENTARY_FACE_TYPES: ReadonlySet<FaceProperties['surfaceType']> = new Set(['plane', 'circle', 'cylinder', 'cone', 'torus']);

type CylinderFilterName = typeof CYLINDER_FILTERS[number];
const CYLINDER_FILTERS = ['cylinder', 'cylinderCurve'] as const;

/**
 * The cylinder filter that admits a face: `cylinder()` for a full wrap
 * (closed circular rim), `cylinderCurve()` for a partial one. Undefined for
 * every other surface.
 */
function cylinderFilterName(props: FaceProperties): CylinderFilterName | undefined {
  if (props.surfaceType !== 'cylinder') {
    return undefined;
  }
  return props.closed ? 'cylinder' : 'cylinderCurve';
}

function sharedString<T extends string>(values: (T | undefined)[]): T | null {
  if (values.length === 0 || values[0] === undefined) {
    return null;
  }
  return values.every(v => v === values[0]) ? values[0] : null;
}

function sharedBoolean(values: boolean[]): boolean | null {
  if (values.length === 0) {
    return null;
  }
  return values.every(v => v === values[0]) ? values[0] : null;
}

function sharedNumber(values: (number | undefined)[]): number | null {
  if (values.length === 0 || values[0] === undefined) {
    return null;
  }
  const first = values[0];
  for (const v of values) {
    if (v === undefined || Math.abs(v - first) > sharedTolerance()) {
      return null;
    }
  }
  return first;
}

/** Values present in every set, in first-set iteration order. */
function sharedMembers(sets: Set<string>[]): string[] {
  if (sets.length === 0) {
    return [];
  }
  return [...sets[0]].filter(v => sets.every(s => s.has(v)));
}
