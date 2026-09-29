// offset-from — the USER offset tie behind the `offsetFrom` statement: each
// target entity is held at `value` from its source entity, pairwise
// (targets[i] ↔ sources[i]), the way Onshape's Offset constraint holds the
// entities its Offset tool draws. The side (left/right of a line, outside/
// inside a circle or arc) is locked from the guess at compile time, like a
// distance dimension's side, so the value is always positive and a warm
// re-solve can never flip a target across its source.
//
// Rows per pair:
//
//   line ↔ line     one RAIL row per target endpoint — the endpoint's signed
//                   distance from the source's infinite line is ±value (2
//                   rows: parallel + distance in one), and for a FOOT
//                   endpoint one more ALONG row pinning it to the
//                   perpendicular foot of the matching source endpoint.
//   arc ↔ arc       concentric (2) + radius difference (1); a FOOT endpoint
//   circle ↔ circle adds the angular row that keeps it on the ray through the
//                   matching source endpoint (its own arc-consistency row
//                   already keeps it on the offset circle).
//
// FOOT vs RAIL: a target endpoint joined by a user coincident to an endpoint
// of ANOTHER target of the same statement is a corner of the offset chain —
// it slides along its offset rail to wherever the neighbour's rail crosses
// (the sharp-corner join). Every other endpoint sits at the perpendicular
// foot of its source's endpoint: the free ends of an open chain, and both
// sides of a tangent junction, where the two offset curves meet on their own
// because their sources do (a coincident there would be second-order, a
// tangent implied — the P1 √tol trap the FOOT rows avoid). The choice is
// re-read at every compile, so a corner coincident added or deleted later
// re-forms the chain without touching this statement.
//
// Every row is a plain function of the target's own params and the source's,
// so a chain of N pairs adds exactly zero net DOF whatever the mix of
// corners, and the coupling is bidirectional: dimensioning an offset entity
// drives its source.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedLine, ResolvedPoint } from './types.js';
import { end, start } from '../types.js';
import { floorDist, guessSign, linePointSignedDist, makeLinePointDeriv } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'offset-from' }>;

type PairKind = 'line' | 'arc' | 'circle';

export function compileOffsetFrom(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (!Number.isFinite(spec.value) || !(spec.value > 0)) {
    throw new Error('offset-from needs a positive distance — the side is read from where the offset entities were drawn');
  }
  if (!Array.isArray(spec.targets) || !Array.isArray(spec.sources) || spec.targets.length === 0) {
    throw new Error('offset-from takes the offset entities and their sources, pairwise');
  }
  if (spec.targets.length !== spec.sources.length) {
    throw new Error(
      `offset-from pairs each offset entity with one source — got ${spec.targets.length} offset ${plural(spec.targets.length, 'entity', 'entities')} and ${spec.sources.length} ${plural(spec.sources.length, 'source', 'sources')}`,
    );
  }
  const targetIds = new Set<number>();
  for (const t of spec.targets) {
    if (t.point !== undefined) {
      throw new Error('offset-from: offset entities must be entities, not points');
    }
    if (targetIds.has(t.entity)) {
      throw new Error('offset-from: the same entity appears twice among the offset entities');
    }
    targetIds.add(t.entity);
  }
  for (const s of spec.sources) {
    if (s.point !== undefined) {
      throw new Error('offset-from: sources must be entities, not points');
    }
    if (targetIds.has(s.entity)) {
      throw new Error('offset-from: an entity cannot be both an offset entity and a source of the same statement');
    }
  }

  const rows: CompiledRow[] = [];
  for (let i = 0; i < spec.targets.length; i++) {
    const kind = pairKind(ctx, spec.targets[i], spec.sources[i], i);
    if (kind === 'line') {
      rows.push(...lineRows(spec, ctx, i));
    } else {
      rows.push(...roundRows(spec, ctx, i, kind));
    }
  }
  return rows;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function pairKind(ctx: CompileCtx, target: SolverRef, source: SolverRef, index: number): PairKind {
  const tk = ctx.kindOf(target.entity);
  const sk = ctx.kindOf(source.entity);
  const where = `offset-from pair ${index + 1}`;
  if (tk !== 'line' && tk !== 'arc' && tk !== 'circle') {
    throw new Error(`${where}: an offset entity must be a line, arc or circle, got ${tk}`);
  }
  if (sk !== tk) {
    throw new Error(`${where}: a ${tk} offsets a ${tk}, got a ${sk} source`);
  }
  return tk;
}

/**
 * The target endpoints of pair `index` a user coincident joins to an
 * endpoint of ANOTHER target of the statement — the chain's corners.
 */
function cornerEnds(spec: Spec, ctx: CompileCtx, index: number): { start: boolean; end: boolean } {
  const own = spec.targets[index];
  const ownStart = ctx.point(start(own.entity), 'offset-from offset entity start');
  const ownEnd = ctx.point(end(own.entity), 'offset-from offset entity end');
  const result = { start: false, end: false };
  for (let j = 0; j < spec.targets.length; j++) {
    if (j === index) {
      continue;
    }
    const other = spec.targets[j];
    if (ctx.kindOf(other.entity) === 'circle') {
      continue;
    }
    for (const ref of [start(other.entity), end(other.entity)]) {
      const p = ctx.point(ref, 'offset-from sibling endpoint');
      if (ctx.arePointsLinked(ownStart, p)) {
        result.start = true;
      }
      if (ctx.arePointsLinked(ownEnd, p)) {
        result.end = true;
      }
    }
  }
  return result;
}

// -- line ↔ line ------------------------------------------------------------

function lineRows(spec: Spec, ctx: CompileCtx, index: number): CompiledRow[] {
  const target = ctx.line(spec.targets[index], 'offset-from offset line');
  const source = ctx.line(spec.sources[index], 'offset-from source line');
  const p = ctx.guess;
  // Side lock: the target's midpoint left (+) or right (−) of the source.
  const lp = makeLinePointDeriv();
  linePointSignedDist(
    p, source,
    (p[target.sx] + p[target.ex]) / 2,
    (p[target.sy] + p[target.ey]) / 2,
    lp,
  );
  const side = guessSign(lp.g);
  const corners = cornerEnds(spec, ctx, index);
  const rows: CompiledRow[] = [];
  for (const role of ['start', 'end'] as const) {
    const q: ResolvedPoint = role === 'start'
      ? { ix: target.sx, iy: target.sy }
      : { ix: target.ex, iy: target.ey };
    rows.push(railRow(source, q, side * spec.value));
    if (!corners[role]) {
      rows.push(alongRow(source, q, nearestLineEnd(p, source, q)));
    }
  }
  return rows;
}

/** g(source, q) − sd = 0: q on the offset rail of the source's infinite line. */
function railRow(l: ResolvedLine, q: ResolvedPoint, sd: number): CompiledRow {
  const d = makeLinePointDeriv();
  return {
    params: [l.sx, l.sy, l.ex, l.ey, q.ix, q.iy],
    eval: (p) => {
      linePointSignedDist(p, l, p[q.ix], p[q.iy], d);
      return d.g - sd;
    },
    jac: (p, out) => {
      linePointSignedDist(p, l, p[q.ix], p[q.iy], d);
      out[0] = d.dSx;
      out[1] = d.dSy;
      out[2] = d.dEx;
      out[3] = d.dEy;
      out[4] = d.dWx;
      out[5] = d.dWy;
    },
  };
}

/** Which source endpoint the target endpoint q sits across from at the guess. */
function nearestLineEnd(p: Float64Array, l: ResolvedLine, q: ResolvedPoint): 'start' | 'end' {
  const ux = p[l.ex] - p[l.sx];
  const uy = p[l.ey] - p[l.sy];
  const len2 = floorDist(ux * ux + uy * uy);
  const t = ((p[q.ix] - p[l.sx]) * ux + (p[q.iy] - p[l.sy]) * uy) / len2;
  return t < 0.5 ? 'start' : 'end';
}

/**
 * dot(q − P, u)/|u| = 0 with P the source endpoint `at` and u the source
 * direction: q is the perpendicular foot of P on its rail.
 */
function alongRow(l: ResolvedLine, q: ResolvedPoint, at: 'start' | 'end'): CompiledRow {
  const px = at === 'start' ? l.sx : l.ex;
  const py = at === 'start' ? l.sy : l.ey;
  return {
    params: [q.ix, q.iy, l.sx, l.sy, l.ex, l.ey],
    eval: (p) => {
      const ux = p[l.ex] - p[l.sx];
      const uy = p[l.ey] - p[l.sy];
      const len = floorDist(Math.hypot(ux, uy));
      return ((p[q.ix] - p[px]) * ux + (p[q.iy] - p[py]) * uy) / len;
    },
    jac: (p, out) => {
      const ux = p[l.ex] - p[l.sx];
      const uy = p[l.ey] - p[l.sy];
      const len = floorDist(Math.hypot(ux, uy));
      const wx = p[q.ix] - p[px];
      const wy = p[q.iy] - p[py];
      const f = (wx * ux + wy * uy) / len;
      // ∂/∂u = w/|u| − f·u/|u|²; u = E − S; P's own column carries −u/|u|.
      const dux = wx / len - (f * ux) / (len * len);
      const duy = wy / len - (f * uy) / (len * len);
      out[0] = ux / len;
      out[1] = uy / len;
      out[2] = -dux;
      out[3] = -duy;
      out[4] = dux;
      out[5] = duy;
      if (at === 'start') {
        out[2] -= ux / len;
        out[3] -= uy / len;
      } else {
        out[4] -= ux / len;
        out[5] -= uy / len;
      }
    },
  };
}

// -- arc ↔ arc, circle ↔ circle ----------------------------------------------

function roundRows(spec: Spec, ctx: CompileCtx, index: number, kind: 'arc' | 'circle'): CompiledRow[] {
  const what = kind === 'arc' ? 'arc' : 'circle';
  const target = ctx.circle(spec.targets[index], `offset-from offset ${what}`);
  const source = ctx.circle(spec.sources[index], `offset-from source ${what}`);
  const p = ctx.guess;
  // Side lock: outside (+) or inside (−) the source's circumference.
  const side = guessSign(p[target.r] - p[source.r]);
  if (side < 0 && !(p[source.r] > spec.value)) {
    throw new Error(
      `offset-from pair ${index + 1}: the inside offset of a radius ${fmt(p[source.r])} ${what} by ${fmt(spec.value)} has no room — the distance must stay below the radius`,
    );
  }
  const rows: CompiledRow[] = [
    linearRow([target.cx, source.cx], [1, -1], 0),
    linearRow([target.cy, source.cy], [1, -1], 0),
    linearRow([target.r, source.r], [1, -1], side * spec.value),
  ];
  if (kind === 'circle') {
    return rows;
  }
  const corners = cornerEnds(spec, ctx, index);
  const tc: ResolvedPoint = { ix: target.cx, iy: target.cy };
  const sc: ResolvedPoint = { ix: source.cx, iy: source.cy };
  for (const role of ['start', 'end'] as const) {
    if (corners[role]) {
      continue;
    }
    const q = ctx.point({ entity: spec.targets[index].entity, point: role }, 'offset-from offset arc endpoint');
    const sourceStart = ctx.point(start(spec.sources[index].entity), 'offset-from source arc start');
    const sourceEnd = ctx.point(end(spec.sources[index].entity), 'offset-from source arc end');
    const s = nearestArcEnd(p, sc, sourceStart, sourceEnd, q, tc);
    if (dot(p, q, tc, s, sc) <= 0) {
      throw new Error(
        `offset-from pair ${index + 1}: the offset arc's ${role} point is not across from an end of its source — draw it on the same side of the center`,
      );
    }
    rows.push(rayRow(q, tc, s, sc));
  }
  return rows;
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Σ coef·p[param] − constant = 0. */
function linearRow(params: number[], coefs: number[], constant: number): CompiledRow {
  return {
    params,
    eval: (p) => {
      let acc = -constant;
      for (let k = 0; k < params.length; k++) {
        acc += coefs[k] * p[params[k]];
      }
      return acc;
    },
    jac: (_p, out) => {
      for (let k = 0; k < params.length; k++) {
        out[k] = coefs[k];
      }
    },
  };
}

/** dot(q − tc, s − sc). */
function dot(p: Float64Array, q: ResolvedPoint, tc: ResolvedPoint, s: ResolvedPoint, sc: ResolvedPoint): number {
  return (p[q.ix] - p[tc.ix]) * (p[s.ix] - p[sc.ix]) + (p[q.iy] - p[tc.iy]) * (p[s.iy] - p[sc.iy]);
}

/** Which source endpoint the target endpoint q lies across from at the guess (by angle). */
function nearestArcEnd(
  p: Float64Array,
  sc: ResolvedPoint,
  sourceStart: ResolvedPoint,
  sourceEnd: ResolvedPoint,
  q: ResolvedPoint,
  tc: ResolvedPoint,
): ResolvedPoint {
  const aq = Math.atan2(p[q.iy] - p[tc.iy], p[q.ix] - p[tc.ix]);
  const as = Math.atan2(p[sourceStart.iy] - p[sc.iy], p[sourceStart.ix] - p[sc.ix]);
  const ae = Math.atan2(p[sourceEnd.iy] - p[sc.iy], p[sourceEnd.ix] - p[sc.ix]);
  const gap = (a: number, b: number): number => {
    const d = Math.abs(a - b) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
  };
  return gap(aq, as) <= gap(aq, ae) ? sourceStart : sourceEnd;
}

/**
 * sin of the angle between a = q − tc and b = s − sc, zero when the target
 * endpoint lies on the ray from its center through the source endpoint's
 * direction. Dimensionless like the parallel row.
 */
function rayRow(q: ResolvedPoint, tc: ResolvedPoint, s: ResolvedPoint, sc: ResolvedPoint): CompiledRow {
  return {
    params: [q.ix, q.iy, tc.ix, tc.iy, s.ix, s.iy, sc.ix, sc.iy],
    eval: (p) => {
      const ax = p[q.ix] - p[tc.ix];
      const ay = p[q.iy] - p[tc.iy];
      const bx = p[s.ix] - p[sc.ix];
      const by = p[s.iy] - p[sc.iy];
      const na = floorDist(Math.hypot(ax, ay));
      const nb = floorDist(Math.hypot(bx, by));
      return (ax * by - ay * bx) / (na * nb);
    },
    jac: (p, out) => {
      const ax = p[q.ix] - p[tc.ix];
      const ay = p[q.iy] - p[tc.iy];
      const bx = p[s.ix] - p[sc.ix];
      const by = p[s.iy] - p[sc.iy];
      const na = floorDist(Math.hypot(ax, ay));
      const nb = floorDist(Math.hypot(bx, by));
      const D = na * nb;
      const h = (ax * by - ay * bx) / D;
      // ∂h/∂a = [by, −bx]/D − h·a/|a|²;  ∂h/∂b = [−ay, ax]/D − h·b/|b|².
      const dax = by / D - (h * ax) / (na * na);
      const day = -bx / D - (h * ay) / (na * na);
      const dbx = -ay / D - (h * bx) / (nb * nb);
      const dby = ax / D - (h * by) / (nb * nb);
      out[0] = dax;
      out[1] = day;
      out[2] = -dax;
      out[3] = -day;
      out[4] = dbx;
      out[5] = dby;
      out[6] = -dbx;
      out[7] = -dby;
    },
  };
}
