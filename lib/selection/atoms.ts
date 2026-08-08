import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Point } from "../math/point.js";
import { toPlane } from "../math/plane.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeProbe, FaceProbe, edgeEndPoints, faceBoundaryPoints } from "./probe.js";

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
  /** True when the predicate only evaluates correctly inside `select()`. */
  needsScope: boolean;
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
 * Format a dimension-like constant, preferring the name of an exactly-equal
 * user parameter. Exact equality (post-rounding) keeps the verification
 * invariant intact: the emitted expression evaluates to the same number the
 * verified builder used.
 */
function linkedConstant(value: number, params: ParameterLink[]): { text: string; value: number } {
  const c = formatConstant(value);
  const match = params.find(p => p.value === c.value);
  if (match) {
    return { text: match.name, value: c.value };
  }
  return c;
}

type PrincipalPlane = { name: 'xy' | 'xz' | 'yz'; axis: 'z' | 'y' | 'x' };

const PRINCIPAL_PLANES: PrincipalPlane[] = [
  { name: 'xy', axis: 'z' },
  { name: 'xz', axis: 'y' },
  { name: 'yz', axis: 'x' },
];

const SHARED_TOLERANCE = 1e-7;

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
 * `allowScoped` gates `belongsToFace` atoms, which need select()'s scope
 * injection and therefore cannot appear in bucket-accessor arguments.
 */
export function instantiateEdgeAtoms(
  probes: EdgeProbe[],
  universe: Edge[],
  allowScoped: boolean,
  params: ParameterLink[] = [],
): EdgeAtom[] {
  const atoms: EdgeAtom[] = [];

  const curveClass = sharedString(probes.map(p => p.props.curveType));
  if (curveClass === 'line') {
    atoms.push({ code: '.line()', addTo: b => b.line(), weight: 30, constants: 0, needsScope: false });
    const length = sharedNumber(probes.map(p => p.props.length));
    if (length !== null) {
      const c = linkedConstant(length, params);
      atoms.push({ code: `.line(${c.text})`, addTo: b => b.line(c.value), weight: 15, constants: 1, needsScope: false });
    }
  }
  if (curveClass === 'arc') {
    atoms.push({ code: '.arc()', addTo: b => b.arc(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius, params);
      atoms.push({ code: `.arc(${c.text})`, addTo: b => b.arc(c.value), weight: 15, constants: 1, needsScope: false });
    }
  }
  if (curveClass === 'circle') {
    atoms.push({ code: '.circle()', addTo: b => b.circle(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius * 2, params);
      atoms.push({ code: `.circle(${c.text})`, addTo: b => b.circle(c.value), weight: 15, constants: 1, needsScope: false });
    }
  }

  for (const plane of PRINCIPAL_PLANES) {
    atoms.push({
      code: `.parallelTo('${plane.name}')`,
      addTo: b => b.parallelTo(plane.name),
      weight: 25, constants: 0, needsScope: false,
    });
    atoms.push({
      code: `.verticalTo('${plane.name}')`,
      addTo: b => b.verticalTo(plane.name),
      weight: 25, constants: 0, needsScope: false,
    });

    const coords = probes.flatMap(p => [...p.ends, p.mid]).map(pt => pt[plane.axis]);
    const shared = sharedNumber(coords);
    if (shared !== null) {
      atoms.push(onPlaneAtom<EdgeFilterBuilder>(plane, shared, params, (b, offset) =>
        offset === 0 ? b.onPlane(plane.name) : b.onPlane(plane.name, offset)));
    }
  }

  const targetEnds = probes.flatMap(p => p.ends);
  const universeEnds = universe.map(e => edgeEndPoints(e));
  atoms.push(...thresholdAtoms<EdgeFilterBuilder>(targetEnds, universeEnds,
    (b, plane, offset) => offset === 0 ? b.above(plane) : b.above(plane, offset),
    (b, plane, offset) => offset === 0 ? b.below(plane) : b.below(plane, offset)));

  if (allowScoped) {
    atoms.push(...belongsToFaceAtoms(probes, params));
  }

  return atoms;
}

export function instantiateFaceAtoms(
  probes: FaceProbe[],
  universe: Face[],
  params: ParameterLink[] = [],
): FaceAtom[] {
  const atoms: FaceAtom[] = [];

  const surfaceClass = sharedString(probes.map(p => p.props.surfaceType));
  if (surfaceClass === 'plane') {
    atoms.push({ code: '.planar()', addTo: b => b.planar(), weight: 30, constants: 0, needsScope: false });
  }
  if (surfaceClass === 'cylinder') {
    atoms.push({ code: '.cylinder()', addTo: b => b.cylinder(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius * 2, params);
      atoms.push({ code: `.cylinder(${c.text})`, addTo: b => b.cylinder(c.value), weight: 15, constants: 1, needsScope: false });
    }
  }
  if (surfaceClass === 'circle') {
    atoms.push({ code: '.circle()', addTo: b => b.circle(), weight: 30, constants: 0, needsScope: false });
    const radius = sharedNumber(probes.map(p => p.props.radius));
    if (radius !== null) {
      const c = linkedConstant(radius * 2, params);
      atoms.push({ code: `.circle(${c.text})`, addTo: b => b.circle(c.value), weight: 15, constants: 1, needsScope: false });
    }
  }
  if (surfaceClass === 'cone') {
    atoms.push({ code: '.cone()', addTo: b => b.cone(), weight: 30, constants: 0, needsScope: false });
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
        weight: 15, constants: 2, needsScope: false,
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
        weight: 12, constants: 1, needsScope: false,
      });
    }
  }

  const targetPoints = probes.flatMap(p => p.points);
  const universePoints = universe.map(f => faceBoundaryPoints(f));
  atoms.push(...thresholdAtoms<FaceFilterBuilder>(targetPoints, universePoints,
    (b, plane, offset) => offset === 0 ? b.above(plane) : b.above(plane, offset),
    (b, plane, offset) => offset === 0 ? b.below(plane) : b.below(plane, offset)));

  return atoms;
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

  if (probes.every(p => p.adjacentFaces.some(f => f.surfaceType === 'cylinder'))) {
    atoms.push({
      code: '.belongsToFace(face().cylinder())',
      addTo: b => b.belongsToFace(new FaceFilterBuilder().cylinder()),
      weight: 18, constants: 0, needsScope: true,
    });
    const diameterSets = probes.map(p => new Set(
      p.adjacentFaces
        .filter(f => f.surfaceType === 'cylinder' && f.radius !== undefined)
        .map(f => formatConstant(f.radius! * 2).text),
    ));
    for (const text of sharedMembers(diameterSets).slice(0, 2)) {
      const value = Number(text);
      const c = linkedConstant(value, params);
      atoms.push({
        code: `.belongsToFace(face().cylinder(${c.text}))`,
        addTo: b => b.belongsToFace(new FaceFilterBuilder().cylinder(value)),
        weight: 14, constants: 1, needsScope: true,
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
  if (probes.every(p => p.adjacentFaces.some(f => f.surfaceType === 'plane'))) {
    atoms.push({
      code: '.belongsToFace(face().planar())',
      addTo: b => b.belongsToFace(new FaceFilterBuilder().planar()),
      weight: 8, constants: 0, needsScope: true,
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
  if (Math.abs(offset) <= SHARED_TOLERANCE) {
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
    weight: 20, constants: 1, needsScope: false,
  };
}

/**
 * `above`/`below` threshold atoms per principal plane. The threshold is a
 * "nice" number placed in the gap between the picked shapes' extent and the
 * nearest universe vertex beyond it — the classic decision-stump cut, and the
 * separator that distinguishes repeat instances from their twins. All cuts
 * are computed in normal-signed coordinates: `above(P, o)` keeps points whose
 * signed distance along P's normal exceeds `o`.
 *
 * A cut that lands exactly at 0 is not a synthetic gap number but the datum
 * plane itself: the picks straddle a principal plane, and the rendered form
 * (`below('xz')`) carries no constant to go stale when dimensions change. Those
 * atoms outrank every constant-bearing predicate — `onPlane(P, o)` at weight 20
 * most importantly — while still deferring to the exact-plane and qualitative
 * forms. Synthetic mid-gap cuts keep the low threshold weight.
 */
function thresholdAtoms<B>(
  targetPoints: Point[],
  universePointSets: Point[][],
  above: (b: B, plane: 'xy' | 'xz' | 'yz', offset: number) => unknown,
  below: (b: B, plane: 'xy' | 'xz' | 'yz', offset: number) => unknown,
): Atom<B>[] {
  const atoms: Atom<B>[] = [];
  for (const plane of PRINCIPAL_PLANES) {
    const sign = planeNormalSign(plane);
    const targetCoords = targetPoints.map(pt => sign * pt[plane.axis]);
    const targetLo = Math.min(...targetCoords);
    const targetHi = Math.max(...targetCoords);
    const universeCoords = universePointSets.flat().map(pt => sign * pt[plane.axis]);

    const beyondLo = universeCoords.filter(v => v < targetLo - SHARED_TOLERANCE);
    if (beyondLo.length > 0) {
      const cut = niceValueInGap(Math.max(...beyondLo), targetLo);
      if (cut !== null) {
        const c = formatConstant(cut);
        atoms.push({
          code: c.value === 0 ? `.above('${plane.name}')` : `.above('${plane.name}', ${c.text})`,
          addTo: b => above(b, plane.name, c.value),
          weight: c.value === 0 ? 21 : 10,
          constants: c.value === 0 ? 0 : 1,
          needsScope: false,
        });
      }
    }

    const beyondHi = universeCoords.filter(v => v > targetHi + SHARED_TOLERANCE);
    if (beyondHi.length > 0) {
      const cut = niceValueInGap(targetHi, Math.min(...beyondHi));
      if (cut !== null) {
        const c = formatConstant(cut);
        atoms.push({
          code: c.value === 0 ? `.below('${plane.name}')` : `.below('${plane.name}', ${c.text})`,
          addTo: b => below(b, plane.name, c.value),
          weight: c.value === 0 ? 21 : 10,
          constants: c.value === 0 ? 0 : 1,
          needsScope: false,
        });
      }
    }
  }
  return atoms;
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
  if (!(hi > lo + SHARED_TOLERANCE * 2)) {
    return null;
  }
  const epsilon = Math.min(1e-6, (hi - lo) / 100);
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

function sharedString<T extends string>(values: (T | undefined)[]): T | null {
  if (values.length === 0 || values[0] === undefined) {
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
    if (v === undefined || Math.abs(v - first) > SHARED_TOLERANCE) {
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
