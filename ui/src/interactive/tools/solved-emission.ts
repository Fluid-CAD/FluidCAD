// Shared solved-sketch emission formatting (sketch-rewrite P5).
//
// Drawing tools in a solved sketch emit fully-specified primitives plus
// explicit constraint statements through the atomic insert-solved rail
// (locked plan §0.1) — this module is the one place their statement text is
// rendered, so tools stop hand-rolling template strings. Emissions must stay
// verbatim-numeric at 2dp: the drag write-back drift-guards source literals
// against the statement-time values (P4 gotcha).

import type {
  SolvedConstraintParam,
  SolvedEmissionTargetParam,
  SolvedGeometryParam,
} from '../../api';
import type { SolvedVertexRef } from '../../snapping/types';
import type { NewVariable, PickedPoint } from '../sketch-tool';

export type { SolvedConstraintParam, SolvedEmissionTargetParam, SolvedGeometryParam };

export type SolvedEmitResult = {
  success: boolean;
  reason?: string;
  geometryLines?: number[];
  names?: (string | null)[];
  /** The sketch statement's post-edit line (imports shift it). */
  sketchLine?: number;
};

export type SolvedEmissionRequest = {
  geometry: SolvedGeometryParam[];
  constraints: SolvedConstraintParam[];
  newVariables?: NewVariable[];
  /** Constraint statements to DELETE in the same edit, by 1-indexed line —
   * the constraint-native fillet removes each corner's coincident as it
   * emits the replacing arc. */
  removals?: { line: number }[];
};

/** Injected into drawing tools inside a solved sketch (null in legacy
 * sketches): the awaited emission rail, guide latch already applied. */
export type SolvedToolContext = {
  emit(request: SolvedEmissionRequest): Promise<SolvedEmitResult>;
  /** The sketch dialog's Auto-constraints toggle (live) — gates the
   * INFERRED constraints (snap coincidents, auto ortho horizontal/vertical),
   * never the gesture-intrinsic ones (shape recipes, chain junctions,
   * tangent/angle modes, typed dimensions). */
  autoConstraints(): boolean;
};

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** A point argument's source text: 2dp for clicked positions, the typed
 * per-axis expressions verbatim for typed ones. */
export function solvedPointText(p: [number, number] | PickedPoint): string {
  if (Array.isArray(p)) {
    return `[${fmt(p[0])}, ${fmt(p[1])}]`;
  }
  return `[${p.xExpr}, ${p.yExpr}]`;
}

export function lineText(
  start: [number, number] | PickedPoint,
  end: [number, number] | PickedPoint,
): string {
  return `line(${solvedPointText(start)}, ${solvedPointText(end)})`;
}

export function arcText(
  start: [number, number] | PickedPoint,
  end: [number, number] | PickedPoint,
  center: [number, number] | PickedPoint,
  cw = false,
): string {
  return `arc(${solvedPointText(start)}, ${solvedPointText(end)}, ${solvedPointText(center)})${cw ? '.cw()' : ''}`;
}

export function circleText(
  center: [number, number] | PickedPoint,
  diameterExpr: string | number,
): string {
  const dia = typeof diameterExpr === 'number' ? fmt(diameterExpr) : diameterExpr;
  return `circle(${solvedPointText(center)}, ${dia})`;
}

export function pointText(p: [number, number] | PickedPoint): string {
  return `point(${solvedPointText(p)})`;
}

/** A snap ref as an emission constraint target. Loop-instance refs carry
 * their occurrence so the server addresses the right instance of a looped
 * statement. */
export function refTarget(ref: SolvedVertexRef): SolvedEmissionTargetParam {
  if (ref.datum !== undefined) {
    return { datum: ref.datum };
  }
  return {
    line: ref.line,
    ...(ref.occurrence !== undefined ? { occurrence: ref.occurrence } : {}),
    ...(ref.role !== undefined ? { role: ref.role } : {}),
    featureType: ref.featureType,
    // Bezier anchor snaps address the snapped control point (P8).
    ...(ref.pointIndex !== undefined ? { pointIndex: ref.pointIndex } : {}),
  };
}

/** A point role on a geometry entry of the same emission. */
export function newTarget(
  newIndex: number,
  role?: 'start' | 'end' | 'center' | 'mid',
): SolvedEmissionTargetParam {
  return { newIndex, ...(role !== undefined ? { role } : {}) };
}

export function coincident(
  a: SolvedEmissionTargetParam,
  b: SolvedEmissionTargetParam,
): SolvedConstraintParam {
  return { kind: 'coincident', targets: [a, b] };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Whether an emitted point still sits on the snapped target, up to the 2dp
 * rounding every emission applies to clicked positions. The old exact
 * (1e-6) comparisons silently dropped snap coincidents whenever the solved
 * vertex wasn't itself on the 2dp grid (solver-adjusted positions rarely
 * are) — the coincident is exactly how the solver closes that residue, so
 * the guard only has to catch a quantization (ortho, on-ray projection,
 * a locked dimension) that actually MOVED the point off the target.
 *
 * An axis-datum snap is a line, not a point: its `point2d` keeps the
 * cursor's free coordinate, which can sit far from where the geometry meets
 * the axis — so with the snap's `ref` given, an axis ref is validated as
 * point-ON-AXIS (the constrained coordinate rounds to 0) instead of
 * point-near-cursor.
 */
export function emittedPointOnSnap(
  emitted: [number, number],
  snapped: [number, number],
  ref?: SolvedVertexRef,
): boolean {
  if (ref?.datum === 'x-axis') {
    return Math.abs(round2(emitted[1])) < 1e-9;
  }
  if (ref?.datum === 'y-axis') {
    return Math.abs(round2(emitted[0])) < 1e-9;
  }
  return Math.abs(round2(emitted[0]) - round2(snapped[0])) < 1e-9
    && Math.abs(round2(emitted[1]) - round2(snapped[1])) < 1e-9;
}

/**
 * Whether two snap refs address the same POINT — the guard against emitting
 * two coincidents of one new shape onto a single snapped vertex. The axis
 * datums are infinite lines, not points: two snaps on one axis are two
 * distinct point-on-axis coincidents, both wanted (comparing their fields
 * naively reads undefined === undefined and swallowed the second — the
 * "only the first vertex auto-constrains" bug for axis snapping). Only the
 * origin datum addresses a point.
 */
export function sameVertexRef(a: SolvedVertexRef, b: SolvedVertexRef): boolean {
  if (a.datum !== undefined || b.datum !== undefined) {
    return a.datum === 'origin' && b.datum === 'origin';
  }
  return a.line === b.line && a.occurrence === b.occurrence
    && a.role === b.role && a.pointIndex === b.pointIndex;
}

/**
 * When BOTH endpoints of a new line are pinned onto the same axis datum,
 * the line's horizontality/verticality is implied — an inferred
 * horizontal/vertical on top would only add a redundant row. Returns the
 * constraint list with the implied kind filtered out, or the list untouched.
 */
export function dropImpliedAxisOrtho(
  constraints: SolvedConstraintParam[],
  startRef: SolvedVertexRef | null,
  endRef: SolvedVertexRef | null,
): SolvedConstraintParam[] {
  const axis = startRef?.datum !== undefined && startRef.datum !== 'origin'
    && endRef?.datum === startRef.datum ? startRef.datum : null;
  if (!axis) {
    return constraints;
  }
  const implied = axis === 'x-axis' ? 'horizontal' : 'vertical';
  return constraints.filter(c => c.kind !== implied);
}

/** A dimension's value expression from a possibly-signed commit: numeric
 * text loses its sign (dimensions are positive; the sign only picked the
 * guess side); non-numeric expressions pass verbatim. */
export function dimMagnitude(expression: string): string {
  const num = parseFloat(expression);
  if (!isNaN(num) && String(num) === expression) {
    return String(Math.abs(num));
  }
  return expression;
}

/**
 * The rect gesture as primitives + constraints (plan §Phase 5): 4 lines,
 * 4 coincident, 2 horizontal + 2 vertical; typed sizes add 2 distance dims.
 * `corner` is the anchor corner (already centered-adjusted by the caller),
 * `w`/`h` signed.
 */
export function rectEmission(opts: {
  corner: [number, number];
  w: number;
  h: number;
  /** Positive width/height dimension expressions — only when typed. */
  widthDim?: string;
  heightDim?: string;
  /** Snapped anchor corner (p0) — coincident onto the snapped vertex. */
  cornerSnap?: SolvedVertexRef;
  /** Snapped opposite corner (p2) — coincident onto the snapped vertex. */
  oppositeSnap?: SolvedVertexRef;
}): SolvedEmissionRequest {
  const [x, y] = opts.corner;
  const p0: [number, number] = [round2(x), round2(y)];
  const p1: [number, number] = [round2(x + opts.w), round2(y)];
  const p2: [number, number] = [round2(x + opts.w), round2(y + opts.h)];
  const p3: [number, number] = [round2(x), round2(y + opts.h)];
  const constraints: SolvedConstraintParam[] = [
    coincident(newTarget(0, 'end'), newTarget(1, 'start')),
    coincident(newTarget(1, 'end'), newTarget(2, 'start')),
    coincident(newTarget(2, 'end'), newTarget(3, 'start')),
    coincident(newTarget(3, 'end'), newTarget(0, 'start')),
    { kind: 'horizontal', targets: [newTarget(0)] },
    { kind: 'horizontal', targets: [newTarget(2)] },
    { kind: 'vertical', targets: [newTarget(1)] },
    { kind: 'vertical', targets: [newTarget(3)] },
  ];
  if (opts.widthDim !== undefined) {
    constraints.push({
      kind: 'distance',
      targets: [newTarget(0, 'start'), newTarget(0, 'end')],
      valueExpr: opts.widthDim,
    });
  }
  if (opts.heightDim !== undefined) {
    constraints.push({
      kind: 'distance',
      targets: [newTarget(1, 'start'), newTarget(1, 'end')],
      valueExpr: opts.heightDim,
    });
  }
  if (opts.cornerSnap !== undefined) {
    constraints.push(coincident(newTarget(0, 'start'), refTarget(opts.cornerSnap)));
  }
  if (opts.oppositeSnap !== undefined) {
    constraints.push(coincident(newTarget(2, 'start'), refTarget(opts.oppositeSnap)));
  }
  return {
    geometry: [
      { kind: 'line', text: lineText(p0, p1) },
      { kind: 'line', text: lineText(p1, p2) },
      { kind: 'line', text: lineText(p2, p3) },
      { kind: 'line', text: lineText(p3, p0) },
    ],
    constraints,
  };
}

/**
 * The rounded-rect gesture: 4 lines + 4 CCW quarter arcs, 8 coincident,
 * 8 tangent, 2 horizontal + 2 vertical, 3 equal radii; typed sizes add
 * overall line–line distance dims and a radius dim. Free DOF = 5
 * (position + w + h + r), matching the drawn intent.
 */
export function roundedRectEmission(opts: {
  corner: [number, number];
  w: number;
  h: number;
  radius: number;
  widthDim?: string;
  heightDim?: string;
  radiusDim?: string;
}): SolvedEmissionRequest {
  const xMin = round2(Math.min(opts.corner[0], opts.corner[0] + opts.w));
  const xMax = round2(Math.max(opts.corner[0], opts.corner[0] + opts.w));
  const yMin = round2(Math.min(opts.corner[1], opts.corner[1] + opts.h));
  const yMax = round2(Math.max(opts.corner[1], opts.corner[1] + opts.h));
  const r = round2(Math.min(Math.abs(opts.radius), (xMax - xMin) / 2, (yMax - yMin) / 2));
  const p = (a: number, b: number): [number, number] => [round2(a), round2(b)];

  // CCW loop from the bottom edge: line, corner arc, line, … Geometry
  // indices: lines 0/2/4/6 (bottom/right/top/left), arcs 1/3/5/7.
  const geometry: SolvedGeometryParam[] = [
    { kind: 'line', text: lineText(p(xMin + r, yMin), p(xMax - r, yMin)) },
    { kind: 'arc', text: arcText(p(xMax - r, yMin), p(xMax, yMin + r), p(xMax - r, yMin + r)) },
    { kind: 'line', text: lineText(p(xMax, yMin + r), p(xMax, yMax - r)) },
    { kind: 'arc', text: arcText(p(xMax, yMax - r), p(xMax - r, yMax), p(xMax - r, yMax - r)) },
    { kind: 'line', text: lineText(p(xMax - r, yMax), p(xMin + r, yMax)) },
    { kind: 'arc', text: arcText(p(xMin + r, yMax), p(xMin, yMax - r), p(xMin + r, yMax - r)) },
    { kind: 'line', text: lineText(p(xMin, yMax - r), p(xMin, yMin + r)) },
    { kind: 'arc', text: arcText(p(xMin, yMin + r), p(xMin + r, yMin), p(xMin + r, yMin + r)) },
  ];
  const constraints: SolvedConstraintParam[] = [];
  for (let i = 0; i < 8; i++) {
    constraints.push(coincident(newTarget(i, 'end'), newTarget((i + 1) % 8, 'start')));
  }
  for (let i = 0; i < 8; i++) {
    // Each junction is line↔arc; name the pair in loop order.
    constraints.push({ kind: 'tangent', targets: [newTarget(i), newTarget((i + 1) % 8)] });
  }
  constraints.push(
    { kind: 'horizontal', targets: [newTarget(0)] },
    { kind: 'horizontal', targets: [newTarget(4)] },
    { kind: 'vertical', targets: [newTarget(2)] },
    { kind: 'vertical', targets: [newTarget(6)] },
    { kind: 'equal', targets: [newTarget(1), newTarget(3)] },
    { kind: 'equal', targets: [newTarget(1), newTarget(5)] },
    { kind: 'equal', targets: [newTarget(1), newTarget(7)] },
  );
  if (opts.widthDim !== undefined) {
    // Overall width = the two vertical lines' separation (line–line distance).
    constraints.push({ kind: 'distance', targets: [newTarget(6), newTarget(2)], valueExpr: opts.widthDim });
  }
  if (opts.heightDim !== undefined) {
    constraints.push({ kind: 'distance', targets: [newTarget(0), newTarget(4)], valueExpr: opts.heightDim });
  }
  if (opts.radiusDim !== undefined) {
    constraints.push({ kind: 'radius', targets: [newTarget(1)], valueExpr: opts.radiusDim });
  }
  return { geometry, constraints };
}

/**
 * The slot gesture: 2 lines + 2 CCW half-circle caps, 4 coincident,
 * 4 tangent, equal radii; typed sizes add a center–center distance and a
 * radius dim. `p0`/`p1` are the centerline endpoints.
 */
export function slotEmission(opts: {
  p0: [number, number];
  p1: [number, number];
  radius: number;
  lengthDim?: string;
  radiusDim?: string;
  /** Snapped cap centres — coincident onto the snapped vertex. p0 is the
   * cap arc at geometry index 3, p1 the one at index 1. */
  p0Snap?: SolvedVertexRef;
  p1Snap?: SolvedVertexRef;
}): SolvedEmissionRequest {
  const dx = opts.p1[0] - opts.p0[0];
  const dy = opts.p1[1] - opts.p0[1];
  const len = Math.hypot(dx, dy) || 1;
  // Right normal: the CCW boundary runs p0→p1 along it, cap, back, cap.
  const nx = (dy / len) * opts.radius;
  const ny = (-dx / len) * opts.radius;
  const p = (a: number, b: number): [number, number] => [round2(a), round2(b)];
  const geometry: SolvedGeometryParam[] = [
    { kind: 'line', text: lineText(p(opts.p0[0] + nx, opts.p0[1] + ny), p(opts.p1[0] + nx, opts.p1[1] + ny)) },
    { kind: 'arc', text: arcText(p(opts.p1[0] + nx, opts.p1[1] + ny), p(opts.p1[0] - nx, opts.p1[1] - ny), p(opts.p1[0], opts.p1[1])) },
    { kind: 'line', text: lineText(p(opts.p1[0] - nx, opts.p1[1] - ny), p(opts.p0[0] - nx, opts.p0[1] - ny)) },
    { kind: 'arc', text: arcText(p(opts.p0[0] - nx, opts.p0[1] - ny), p(opts.p0[0] + nx, opts.p0[1] + ny), p(opts.p0[0], opts.p0[1])) },
  ];
  const constraints: SolvedConstraintParam[] = [
    coincident(newTarget(0, 'end'), newTarget(1, 'start')),
    coincident(newTarget(1, 'end'), newTarget(2, 'start')),
    coincident(newTarget(2, 'end'), newTarget(3, 'start')),
    coincident(newTarget(3, 'end'), newTarget(0, 'start')),
    { kind: 'tangent', targets: [newTarget(0), newTarget(1)] },
    { kind: 'tangent', targets: [newTarget(1), newTarget(2)] },
    { kind: 'tangent', targets: [newTarget(2), newTarget(3)] },
    { kind: 'tangent', targets: [newTarget(3), newTarget(0)] },
    { kind: 'equal', targets: [newTarget(1), newTarget(3)] },
  ];
  if (opts.lengthDim !== undefined) {
    constraints.push({
      kind: 'distance',
      targets: [newTarget(3, 'center'), newTarget(1, 'center')],
      valueExpr: opts.lengthDim,
    });
  }
  if (opts.radiusDim !== undefined) {
    constraints.push({ kind: 'radius', targets: [newTarget(1)], valueExpr: opts.radiusDim });
  }
  if (opts.p0Snap !== undefined) {
    constraints.push(coincident(newTarget(3, 'center'), refTarget(opts.p0Snap)));
  }
  if (opts.p1Snap !== undefined) {
    constraints.push(coincident(newTarget(1, 'center'), refTarget(opts.p1Snap)));
  }
  return { geometry, constraints };
}

export type PolygonMode = 'circumscribed' | 'inscribed';

/**
 * The polygon gesture (guide-circle form): n lines around a `.guide()`
 * circle (geometry index n) — n chain coincidents, ONE variadic equal, and
 * the mode's circle tie: every side tangent to the circle (circumscribed)
 * or every vertex on it (inscribed). The ⌀ is the guide circle's diameter —
 * across flats when circumscribed, across corners when inscribed — so a
 * typed ⌀ dims the circle directly for either mode and any n.
 *
 * Even-n circumscribed trap (Pitot identity): a tangential equilateral
 * polygon with even n has one tangent row dependent AND keeps a genuine
 * internal freedom (the "squished hexagon" family), so all-tangent +
 * full-equal solves at DOF 5 with a permanently-flagged redundant row. The
 * recipe therefore leaves the last side out of the equal (Pitot forces it
 * equal anyway) and pins the internal freedom with one regular corner
 * angle — DOF 4, rank-clean. Verified across modes/parities by the server
 * DOF tests (solved-shape-emissions).
 */
export function polygonEmission(opts: {
  center: [number, number];
  /** The guide circle's diameter — the tool's ⌀. */
  diameter: number;
  sides: number;
  mode: PolygonMode;
  /** Angle of the first vertex, radians (the preview's convention: 0). */
  startAngle?: number;
  diameterDim?: string;
}): SolvedEmissionRequest {
  const n = Math.max(3, Math.round(opts.sides));
  const guideR = Math.abs(opts.diameter) / 2;
  const rad = opts.mode === 'circumscribed' ? guideR / Math.cos(Math.PI / n) : guideR;
  const a0 = opts.startAngle ?? 0;
  const vertex = (i: number): [number, number] => [
    round2(opts.center[0] + rad * Math.cos(a0 + (i * 2 * Math.PI) / n)),
    round2(opts.center[1] + rad * Math.sin(a0 + (i * 2 * Math.PI) / n)),
  ];
  const geometry: SolvedGeometryParam[] = [];
  for (let i = 0; i < n; i++) {
    geometry.push({ kind: 'line', text: lineText(vertex(i), vertex(i + 1)) });
  }
  const circleIdx = n;
  geometry.push({
    kind: 'circle',
    text: circleText(opts.center, Math.abs(opts.diameter)),
    guide: true,
  });
  const constraints: SolvedConstraintParam[] = [];
  for (let i = 0; i < n; i++) {
    constraints.push(coincident(newTarget(i, 'end'), newTarget((i + 1) % n, 'start')));
  }
  const dropLastEqual = opts.mode === 'circumscribed' && n % 2 === 0;
  constraints.push({
    kind: 'equal',
    targets: Array.from({ length: dropLastEqual ? n - 1 : n }, (_, i) => newTarget(i)),
  });
  if (opts.mode === 'circumscribed') {
    for (let i = 0; i < n; i++) {
      constraints.push({ kind: 'tangent', targets: [newTarget(i), newTarget(circleIdx)] });
    }
    if (dropLastEqual) {
      constraints.push({
        kind: 'angle',
        targets: [newTarget(0), newTarget(1)],
        valueExpr: String(round2(360 / n)),
      });
    }
  } else {
    for (let i = 0; i < n; i++) {
      constraints.push(coincident(newTarget(i, 'start'), newTarget(circleIdx)));
    }
  }
  if (opts.diameterDim !== undefined) {
    constraints.push({
      kind: 'diameter',
      targets: [newTarget(circleIdx)],
      valueExpr: opts.diameterDim,
    });
  }
  return { geometry, constraints };
}

/**
 * The chain-junction angle statement per the P4 positive-only CCW rule:
 * `angle(a, b, deg)` is the CCW angle from a's oriented direction to b's,
 * emitted with the argument order picked so the value is ≤ 180°. Directions
 * are the drawing directions (start→end), so no `.start()` flips are needed.
 * Returns null for degenerate directions.
 */
export function chainAngleConstraint(
  prev: SolvedEmissionTargetParam,
  next: SolvedEmissionTargetParam,
  prevDir: [number, number],
  nextDir: [number, number],
): SolvedConstraintParam | null {
  const cross = prevDir[0] * nextDir[1] - prevDir[1] * nextDir[0];
  const dot = prevDir[0] * nextDir[0] + prevDir[1] * nextDir[1];
  if (Math.abs(cross) < 1e-12 && Math.abs(dot) < 1e-12) {
    return null;
  }
  let ccw = Math.atan2(cross, dot) * (180 / Math.PI);
  if (ccw < 0) {
    ccw += 360;
  }
  const swap = ccw > 180;
  const deg = swap ? 360 - ccw : ccw;
  const rounded = Math.round(deg * 100) / 100;
  return {
    kind: 'angle',
    targets: swap ? [next, prev] : [prev, next],
    valueExpr: String(rounded),
  };
}
