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
  return { geometry, constraints };
}

/**
 * The polygon gesture: n lines, n coincident, n−1 equal sides, n−3 corner
 * angles (the CCW exterior turn 360/n) — exactly the regular polygon's
 * 4 freedoms (position + rotation + size) for every n.
 *
 * NOT a construction circle + tangents: a tangential equilateral polygon
 * with EVEN n satisfies the Pitot identity, which makes one tangent row
 * redundant AND leaves a genuine internal freedom (the "squished hexagon"
 * family) — verified by the DOF tests.
 *
 * A typed ⌀ (across flats) dims the opposite-side line–line distance for
 * even n verbatim; odd n has no two-entity across-flats measure, so the ⌀
 * converts to a numeric side-length dim (side = ⌀·tan(π/n)).
 */
export function polygonEmission(opts: {
  center: [number, number];
  /** Across-flats (inscribed-circle) diameter — the tool's ⌀. */
  diameter: number;
  sides: number;
  /** Angle of the first vertex, radians (the preview's convention: 0). */
  startAngle?: number;
  diameterDim?: string;
}): SolvedEmissionRequest {
  const n = Math.max(3, Math.round(opts.sides));
  const inscribed = Math.abs(opts.diameter) / 2;
  const rad = inscribed / Math.cos(Math.PI / n);
  const a0 = opts.startAngle ?? 0;
  const vertex = (i: number): [number, number] => [
    round2(opts.center[0] + rad * Math.cos(a0 + (i * 2 * Math.PI) / n)),
    round2(opts.center[1] + rad * Math.sin(a0 + (i * 2 * Math.PI) / n)),
  ];
  const geometry: SolvedGeometryParam[] = [];
  for (let i = 0; i < n; i++) {
    geometry.push({ kind: 'line', text: lineText(vertex(i), vertex(i + 1)) });
  }
  const constraints: SolvedConstraintParam[] = [];
  for (let i = 0; i < n; i++) {
    constraints.push(coincident(newTarget(i, 'end'), newTarget((i + 1) % n, 'start')));
  }
  for (let i = 1; i < n; i++) {
    constraints.push({ kind: 'equal', targets: [newTarget(0), newTarget(i)] });
  }
  const turn = round2(360 / n);
  for (let i = 0; i < n - 3; i++) {
    constraints.push({
      kind: 'angle',
      targets: [newTarget(i), newTarget(i + 1)],
      valueExpr: String(turn),
    });
  }
  if (opts.diameterDim !== undefined) {
    if (n % 2 === 0) {
      constraints.push({
        kind: 'distance',
        targets: [newTarget(0), newTarget(n / 2)],
        valueExpr: opts.diameterDim,
      });
    } else {
      constraints.push({
        kind: 'distance',
        targets: [newTarget(0, 'start'), newTarget(0, 'end')],
        valueExpr: String(round2(Math.abs(opts.diameter) * Math.tan(Math.PI / n))),
      });
    }
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
