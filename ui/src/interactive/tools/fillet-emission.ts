// Constraint-native 2D fillet (sketch-rewrite P8).
//
// The Fillet tool no longer writes a `fillet(r, …)` derived op: it emits, per
// shared corner among the picked edges, a real `arc(start, end, center)`
// statement plus the constraints that make it a fillet — two coincidents
// (the arc's ends onto the trimmed edges' endpoints) and two tangents — with
// one `radius(a1, r)` dimension on the first arc and pairwise `equal` across
// the rest (the rounded-rect recipe). The pre-existing corner coincident is
// deleted in the same edit (`removals`), or the corner would be
// over-constrained. The solver then pulls the edge endpoints back to the
// tangent points; source literals stay as (stale, harmless) guesses.
//
// The math here only supplies the GUESS geometry — the constraints own the
// truth. Line–line corners are exact; corners involving arcs solve the
// offset-intersection candidates and pick the one nearest the corner.

import type { SolvedConstraintParam, SolvedEmissionTargetParam, SolvedGeometryParam } from '../../api';
import type { SolvedConstraintView, SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client/model';
import type { SolvedPick } from '../sketch-hover-select-handler';
import { arcText, coincident, newTarget, type SolvedEmissionRequest } from './solved-emission';

/** Two solved endpoints within this distance read as one corner. Solved
 * coincident corners agree to ~1e-9; literal-coincident ones exactly. */
const CORNER_TOL = 1e-3;

/** A tangency-distance mismatch beyond this rejects an offset-intersection
 * candidate (numerical guard — candidates satisfy it by construction). */
const RADIUS_TOL = 1e-6;

type V2 = [number, number];

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: V2, b: V2): number => a[0] * b[1] - a[1] * b[0];
const norm = (a: V2): number => Math.hypot(a[0], a[1]);
const unit = (a: V2): V2 => mul(a, 1 / (norm(a) || 1));
/** +90° rotation. */
const perp = (a: V2): V2 => [-a[1], a[0]];

/** Angle of `p` around `c`. */
const angleAt = (c: V2, p: V2): number => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** `a` normalized into [0, 2π). */
const wrap = (a: number): number => {
  const TAU = 2 * Math.PI;
  return ((a % TAU) + TAU) % TAU;
};

/** One picked edge, resolved to fillet-relevant data. */
type PickedCurve = {
  entityId: number;
  kind: 'line' | 'arc';
  view: SolvedEntityView;
  /** The statement's 1-indexed source line. */
  line: number;
};

/** A curve as seen from one of its endpoints (the corner). */
type CornerCurve =
  | { type: 'line'; p: V2; dir: V2; len: number }
  | {
    type: 'arc'; p: V2; center: V2; r: number;
    /** Angular direction of travel from `p` INTO the arc: +1 CCW, -1 CW. */
    travel: 1 | -1;
    /** The arc's full angular span — how far the fillet may advance. */
    sweep: number;
  };

type CornerEnd = { curve: number; role: 'start' | 'end' };

type CornerPlan = {
  a: CornerEnd;
  b: CornerEnd;
  /** The shared corner position. */
  at: V2;
  /** Fillet arc guess. */
  start: V2;
  end: V2;
  center: V2;
  cw: boolean;
  /** Arc-length taken from each curve, for the per-curve capacity check. */
  advanceA: number;
  advanceB: number;
};

export type FilletEmissionPlan = {
  ok: true;
  request: SolvedEmissionRequest;
  corners: number;
};

export type FilletEmissionError = { ok: false; reason: string };

const fail = (reason: string): FilletEmissionError => ({ ok: false, reason });

function endpointOf(view: SolvedEntityView, role: 'start' | 'end'): V2 | null {
  const p = role === 'start' ? view.start : view.end;
  return p ? [p[0], p[1]] : null;
}

/** The arc's angular span in its drawn direction (start → end). */
function arcSweep(view: SolvedEntityView): number {
  const c = view.center as V2;
  const a0 = angleAt(c, view.start as V2);
  const a1 = angleAt(c, view.end as V2);
  const s = view.cw ? wrap(a0 - a1) : wrap(a1 - a0);
  return s === 0 ? 2 * Math.PI : s;
}

function cornerCurve(curve: PickedCurve, role: 'start' | 'end'): CornerCurve | null {
  const view = curve.view;
  const p = endpointOf(view, role);
  if (!p) {
    return null;
  }
  if (curve.kind === 'line') {
    const other = endpointOf(view, role === 'start' ? 'end' : 'start');
    if (!other) {
      return null;
    }
    const d = sub(other, p);
    const len = norm(d);
    if (len < CORNER_TOL) {
      return null;
    }
    return { type: 'line', p, dir: mul(d, 1 / len), len };
  }
  const center = view.center as V2 | undefined;
  if (!center || view.radius === undefined || !view.start || !view.end) {
    return null;
  }
  const ccw = view.cw !== true;
  // Travel INTO the arc: forward from its start, backward from its end.
  const travel: 1 | -1 = role === 'start' ? (ccw ? 1 : -1) : (ccw ? -1 : 1);
  return { type: 'arc', p, center, r: view.radius, travel, sweep: arcSweep(view) };
}

/** Offset loci of a corner curve at distance `r` — the fillet center lies on
 * one of them. */
type OffsetLocus =
  | { type: 'line'; p: V2; dir: V2 }
  | { type: 'circle'; center: V2; r: number };

function offsetLoci(curve: CornerCurve, r: number): OffsetLocus[] {
  if (curve.type === 'line') {
    const n = perp(curve.dir);
    return [
      { type: 'line', p: add(curve.p, mul(n, r)), dir: curve.dir },
      { type: 'line', p: add(curve.p, mul(n, -r)), dir: curve.dir },
    ];
  }
  const loci: OffsetLocus[] = [{ type: 'circle', center: curve.center, r: curve.r + r }];
  if (Math.abs(curve.r - r) > RADIUS_TOL) {
    loci.push({ type: 'circle', center: curve.center, r: Math.abs(curve.r - r) });
  }
  return loci;
}

function intersectLoci(a: OffsetLocus, b: OffsetLocus): V2[] {
  if (a.type === 'line' && b.type === 'line') {
    const d = cross(a.dir, b.dir);
    if (Math.abs(d) < 1e-12) {
      return [];
    }
    const t = cross(sub(b.p, a.p), b.dir) / d;
    return [add(a.p, mul(a.dir, t))];
  }
  if (a.type === 'line' && b.type === 'circle') {
    // Project the circle center onto the line; branch on the half-chord.
    const t0 = dot(sub(b.center, a.p), a.dir);
    const foot = add(a.p, mul(a.dir, t0));
    const h2 = b.r * b.r - dot(sub(b.center, foot), sub(b.center, foot));
    if (h2 < -1e-12) {
      return [];
    }
    const h = Math.sqrt(Math.max(0, h2));
    return h < 1e-12
      ? [foot]
      : [add(foot, mul(a.dir, h)), add(foot, mul(a.dir, -h))];
  }
  if (a.type === 'circle' && b.type === 'line') {
    return intersectLoci(b, a);
  }
  const ca = a as Extract<OffsetLocus, { type: 'circle' }>;
  const cb = b as Extract<OffsetLocus, { type: 'circle' }>;
  const d = norm(sub(cb.center, ca.center));
  if (d < 1e-12 || d > ca.r + cb.r + 1e-9 || d < Math.abs(ca.r - cb.r) - 1e-9) {
    return [];
  }
  const x = (d * d + ca.r * ca.r - cb.r * cb.r) / (2 * d);
  const h2 = ca.r * ca.r - x * x;
  const h = Math.sqrt(Math.max(0, h2));
  const u = unit(sub(cb.center, ca.center));
  const foot = add(ca.center, mul(u, x));
  const n = perp(u);
  return h < 1e-12
    ? [foot]
    : [add(foot, mul(n, h)), add(foot, mul(n, -h))];
}

/** Tangent point and arc-length advance of fillet-center candidate `x` on
 * `curve`, or null when the tangency lands off the curve near the corner. */
function tangentOn(curve: CornerCurve, x: V2, r: number): { tp: V2; advance: number } | null {
  if (curve.type === 'line') {
    const t = dot(sub(x, curve.p), curve.dir);
    if (t < RADIUS_TOL || t > curve.len + CORNER_TOL) {
      return null;
    }
    const tp = add(curve.p, mul(curve.dir, t));
    if (Math.abs(norm(sub(x, tp)) - r) > 1e-6 * Math.max(1, r)) {
      return null;
    }
    return { tp, advance: t };
  }
  const radial = sub(x, curve.center);
  const dist = norm(radial);
  if (dist < 1e-12) {
    return null;
  }
  const tp = add(curve.center, mul(radial, curve.r / dist));
  if (Math.abs(norm(sub(x, tp)) - r) > 1e-6 * Math.max(1, r)) {
    return null;
  }
  const da = wrap((angleAt(curve.center, tp) - angleAt(curve.center, curve.p)) * curve.travel);
  if (da < RADIUS_TOL || da > curve.sweep + CORNER_TOL / Math.max(curve.r, CORNER_TOL)) {
    return null;
  }
  return { tp, advance: da * curve.r };
}

/** Whether the fillet arc from `start` to `end` around `center` should sweep
 * clockwise: the sweep whose midpoint stays near the corner is the fillet. */
function filletCw(start: V2, end: V2, center: V2, corner: V2): boolean {
  const r = norm(sub(start, center));
  const a1 = angleAt(center, start);
  const a2 = angleAt(center, end);
  const ccwMid = a1 + wrap(a2 - a1) / 2;
  const cwMid = a1 - wrap(a1 - a2) / 2;
  const pCcw = add(center, [r * Math.cos(ccwMid), r * Math.sin(ccwMid)]);
  const pCw = add(center, [r * Math.cos(cwMid), r * Math.sin(cwMid)]);
  return norm(sub(pCw, corner)) < norm(sub(pCcw, corner));
}

/** Solve one corner: enumerate offset-locus intersections and keep the valid
 * candidate that stays nearest the corner. */
function solveCorner(
  a: CornerCurve,
  b: CornerCurve,
  corner: V2,
  radius: number,
): { center: V2; start: V2; end: V2; cw: boolean; advanceA: number; advanceB: number } | null {
  let best: { center: V2; ta: { tp: V2; advance: number }; tb: { tp: V2; advance: number } } | null = null;
  for (const la of offsetLoci(a, radius)) {
    for (const lb of offsetLoci(b, radius)) {
      for (const x of intersectLoci(la, lb)) {
        const ta = tangentOn(a, x, radius);
        const tb = tangentOn(b, x, radius);
        if (!ta || !tb) {
          continue;
        }
        if (!best || ta.advance + tb.advance < best.ta.advance + best.tb.advance) {
          best = { center: x, ta, tb };
        }
      }
    }
  }
  if (!best) {
    return null;
  }
  return {
    center: best.center,
    start: best.ta.tp,
    end: best.tb.tp,
    cw: filletCw(best.ta.tp, best.tb.tp, best.center, corner),
    advanceA: best.ta.advance,
    advanceB: best.tb.advance,
  };
}

/** The coincident statements pinning this corner — the lines to remove. */
function cornerCoincidentLines(
  constraints: SolvedConstraintView[],
  a: { entityId: number; role: 'start' | 'end' },
  b: { entityId: number; role: 'start' | 'end' },
): number[] {
  const lines: number[] = [];
  for (const c of constraints) {
    const spec = c.spec as { kind: string; a?: { entity: number; point?: string }; b?: { entity: number; point?: string } };
    if (spec.kind !== 'coincident' || !spec.a || !spec.b
      || spec.a.point === undefined || spec.b.point === undefined) {
      continue;
    }
    const matches = (spec.a.entity === a.entityId && spec.a.point === a.role
      && spec.b.entity === b.entityId && spec.b.point === b.role)
      || (spec.a.entity === b.entityId && spec.a.point === b.role
        && spec.b.entity === a.entityId && spec.b.point === a.role);
    if (matches && c.obj.sourceLocation?.line !== undefined) {
      lines.push(c.obj.sourceLocation.line);
    }
  }
  return lines;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const p2 = (p: V2): V2 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

/**
 * Build the constraint-native fillet emission for the current picks.
 * `radiusExpr` rides the radius dimension verbatim; `radius` is the numeric
 * value the guess geometry is computed from.
 */
export function buildFilletEmission(opts: {
  picks: SolvedPick[];
  model: SolvedSketchModel;
  radius: number;
  radiusExpr: string;
}): FilletEmissionPlan | FilletEmissionError {
  const { model, radius } = opts;
  if (!(radius > 0)) {
    return fail('enter a positive radius');
  }

  // Resolve the edge picks (vertex picks are ignored — the dialog's chips
  // only mirror edges) into fillet-able curves.
  const curves: PickedCurve[] = [];
  const seen = new Set<number>();
  for (const pick of opts.picks) {
    if (pick.role !== undefined || pick.datum !== undefined) {
      continue;
    }
    if (seen.has(pick.entityId)) {
      continue;
    }
    if (pick.reference !== undefined) {
      return fail('projected reference edges are fixed — they cannot be trimmed by a fillet');
    }
    if (pick.copyInstance !== undefined) {
      return fail('copy instances mirror their source rigidly — fillet the source edges instead');
    }
    if (pick.anchor !== undefined) {
      return fail(`a ${pick.anchor.owner} has no corner to fillet — pick lines or arcs`);
    }
    if (pick.kind !== 'line' && pick.kind !== 'arc') {
      return fail(`a ${pick.kind} has no corner to fillet — pick lines or arcs`);
    }
    if (pick.sourceLocation?.occurrence !== undefined) {
      return fail('loop instances cannot be filleted yet — fillet applies to single statements');
    }
    const view = model.entities.get(pick.entityId);
    const line = pick.sourceLocation?.line;
    if (!view || line === undefined) {
      continue;
    }
    seen.add(pick.entityId);
    curves.push({ entityId: pick.entityId, kind: pick.kind, view, line });
  }
  if (curves.length < 2) {
    return fail('pick two or more edges that share a corner');
  }

  // Corner detection: endpoint pairs across distinct picked curves that sit
  // at the same solved position. Each endpoint may join exactly one corner —
  // three edges meeting at a point have no unambiguous fillet.
  const cornerEnds: { a: CornerEnd; b: CornerEnd; at: V2 }[] = [];
  const usedEnds = new Map<string, number>();
  const endKey = (e: CornerEnd): string => `${e.curve}:${e.role}`;
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const roleI of ['start', 'end'] as const) {
        for (const roleJ of ['start', 'end'] as const) {
          const pi = endpointOf(curves[i].view, roleI);
          const pj = endpointOf(curves[j].view, roleJ);
          if (!pi || !pj || norm(sub(pi, pj)) > CORNER_TOL) {
            continue;
          }
          const a: CornerEnd = { curve: i, role: roleI };
          const b: CornerEnd = { curve: j, role: roleJ };
          for (const e of [a, b]) {
            const prior = usedEnds.get(endKey(e));
            if (prior !== undefined) {
              return fail('more than two picked edges meet at the same corner — fillet them pairwise');
            }
          }
          usedEnds.set(endKey(a), cornerEnds.length);
          usedEnds.set(endKey(b), cornerEnds.length);
          cornerEnds.push({ a, b, at: pi });
        }
      }
    }
  }
  if (cornerEnds.length === 0) {
    return fail(curves.length === 2
      ? 'the picked edges do not share a corner — fillet rounds the corner between adjacent edges'
      : 'the picked edges do not share any corners');
  }

  // Solve every corner; track per-curve arc-length take-up so two fillets on
  // one short edge refuse instead of overlapping.
  const plans: CornerPlan[] = [];
  const takeUp = new Map<number, number>();
  for (const corner of cornerEnds) {
    const ca = cornerCurve(curves[corner.a.curve], corner.a.role);
    const cb = cornerCurve(curves[corner.b.curve], corner.b.role);
    if (!ca || !cb) {
      return fail('a picked edge is degenerate at the corner');
    }
    const solved = solveCorner(ca, cb, corner.at, radius);
    if (!solved) {
      return fail(`radius ${fmt(radius)} does not fit the corner at [${fmt(corner.at[0])}, ${fmt(corner.at[1])}]`);
    }
    plans.push({ ...corner, ...solved });
    takeUp.set(corner.a.curve, (takeUp.get(corner.a.curve) ?? 0) + solved.advanceA);
    takeUp.set(corner.b.curve, (takeUp.get(corner.b.curve) ?? 0) + solved.advanceB);
  }
  for (const [index, total] of takeUp) {
    const curve = curves[index];
    const capacity = curve.kind === 'line'
      ? norm(sub(curve.view.end as V2, curve.view.start as V2))
      : arcSweep(curve.view) * (curve.view.radius ?? 0);
    if (total > capacity + CORNER_TOL) {
      return fail(`radius ${fmt(radius)} is too large — the fillets consume more than a picked edge`);
    }
  }

  // Emission: one arc per corner, the corner's own recipe, one radius dim on
  // the first arc, pairwise equal across the rest, and the corner
  // coincidents removed.
  const existingTarget = (end: CornerEnd, role?: 'start' | 'end'): SolvedEmissionTargetParam => ({
    line: curves[end.curve].line,
    featureType: curves[end.curve].kind,
    ...(role !== undefined ? { role } : {}),
  });
  const geometry: SolvedGeometryParam[] = [];
  const constraints: SolvedConstraintParam[] = [];
  const removalLines = new Set<number>();
  plans.forEach((plan, k) => {
    geometry.push({ kind: 'arc', text: arcText(p2(plan.start), p2(plan.end), p2(plan.center), plan.cw) });
    constraints.push(
      coincident(newTarget(k, 'start'), existingTarget(plan.a, plan.a.role)),
      coincident(newTarget(k, 'end'), existingTarget(plan.b, plan.b.role)),
      { kind: 'tangent', targets: [existingTarget(plan.a), newTarget(k)] },
      { kind: 'tangent', targets: [newTarget(k), existingTarget(plan.b)] },
    );
    for (const line of cornerCoincidentLines(
      model.constraints,
      { entityId: curves[plan.a.curve].entityId, role: plan.a.role },
      { entityId: curves[plan.b.curve].entityId, role: plan.b.role },
    )) {
      removalLines.add(line);
    }
  });
  constraints.push({ kind: 'radius', targets: [newTarget(0)], valueExpr: opts.radiusExpr });
  for (let k = 1; k < plans.length; k++) {
    constraints.push({ kind: 'equal', targets: [newTarget(0), newTarget(k)] });
  }

  return {
    ok: true,
    corners: plans.length,
    request: {
      geometry,
      constraints,
      ...(removalLines.size > 0
        ? { removals: [...removalLines].map(line => ({ line })) }
        : {}),
    },
  };
}
