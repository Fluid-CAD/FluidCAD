// The sketch Split tool's client-side plan (2D split).
//
// A split is one click on an edge. Everything the server needs that only
// the render knows is gathered here: which statement the edge belongs to,
// the entity's SOLVED geometry (its literals are guesses), where the click
// landed, and — for every constraint that addresses the whole entity and
// acts somewhere along it — the place it touches the entity, so the route
// can hand it to the piece that place falls on. The kernel cuts, the
// statement transform rewrites; nothing geometric is decided here.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SplittableEntityParam } from '../../api';
import type { SolvedConstraintView, SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client/model';
import {
  add, dist, entityFor, footOnLine, lineMid, pointOnCircumference, refPoint, scale, sub, tangencyPoint, type Vec2,
} from '../../sketch-solver-client/resolve';
import type { SolvedPick } from '../sketch-hover-select-handler';

export type SplitRequest = {
  /** 1-indexed line of the entity statement. */
  line: number;
  entity: SplittableEntityParam;
  /** Where the click landed, sketch-local. */
  at: Vec2;
  hints: { line: number; locus: Vec2 }[];
};

export type SplitPlan =
  | { ok: true; request: SplitRequest }
  | { ok: false; reason: string };

const refuse = (reason: string): SplitPlan => ({ ok: false, reason });

/** Why a pick cannot be split, or null when it can. */
export function splitRefusalFor(pick: SolvedPick): string | null {
  if (pick.datum !== undefined) {
    return "The sketch axes can't be split";
  }
  if (pick.role !== undefined) {
    return 'Click on the edge itself, not one of its points';
  }
  if (pick.reference) {
    return "A projected reference can't be split";
  }
  if (pick.copyInstance) {
    return "A copy can't be split — split its source edge instead";
  }
  if (pick.mirrorInstance) {
    return "A mirror image can't be split — split its source edge instead";
  }
  if (pick.anchor) {
    return pick.anchor.owner === 'text' ? "Text can't be split" : "Bezier curves can't be split";
  }
  if (pick.kind === 'ellipse') {
    return "Ellipses can't be split yet";
  }
  if (pick.kind === 'point') {
    return "A point can't be split";
  }
  if (pick.sourceLocation?.occurrence !== undefined) {
    return 'This edge is drawn by a loop — edit the source instead';
  }
  if (pick.sourceLocation?.line === undefined) {
    return 'This edge has no statement to split';
  }
  if (!pick.at) {
    return 'Click on the edge where it should split';
  }
  return null;
}

export function buildSplitPlan(pick: SolvedPick, model: SolvedSketchModel): SplitPlan {
  const refusal = splitRefusalFor(pick);
  if (refusal !== null) {
    return refuse(refusal);
  }
  const view = model.entities.get(pick.entityId);
  const entity = view ? entityGeometry(view) : null;
  if (!view || !entity) {
    return refuse("The edge's geometry is not available");
  }
  return {
    ok: true,
    request: {
      line: pick.sourceLocation!.line,
      entity,
      at: pick.at!,
      hints: view.kind === 'line' ? lineHints(view, model) : [],
    },
  };
}

function entityGeometry(view: SolvedEntityView): SplittableEntityParam | null {
  switch (view.kind) {
    case 'line':
      return view.start && view.end ? { kind: 'line', start: view.start, end: view.end } : null;
    case 'arc':
      return view.start && view.end && view.center
        ? { kind: 'arc', start: view.start, end: view.end, center: view.center, cw: view.cw ?? false }
        : null;
    case 'circle':
      return view.center && view.radius !== undefined
        ? { kind: 'circle', center: view.center, radius: view.radius }
        : null;
    default:
      return null;
  }
}

/**
 * Where each whole-line constraint touches the line. Only lines need this:
 * the pieces of an arc or circle ride one circle, so every constraint on
 * the circle's geometry keeps its meaning on the first piece. A line's
 * pieces can bend at the junction, so a point on the line, a tangency or a
 * distance belongs with the piece it sits on.
 */
function lineHints(line: SolvedEntityView, model: SolvedSketchModel): { line: number; locus: Vec2 }[] {
  const hints: { line: number; locus: Vec2 }[] = [];
  for (const c of model.constraints) {
    const statementLine = c.obj.sourceLocation?.line;
    if (statementLine === undefined) {
      continue;
    }
    const other = otherRefOf(c, line.entityId);
    if (other === null) {
      continue;
    }
    const locus = locusOf(c.spec.kind, line, other, model);
    if (locus) {
      hints.push({ line: statementLine, locus });
    }
  }
  return hints;
}

/** The ref a two-ref constraint pairs with a BARE reference to `entityId`, or null. */
function otherRefOf(c: SolvedConstraintView, entityId: number): SolverRef | null {
  const spec = c.spec as ConstraintSpec & { a?: SolverRef; b?: SolverRef };
  const refs = [spec.a, spec.b].filter((r): r is SolverRef => r !== undefined);
  if (refs.length !== 2) {
    return null;
  }
  const bare = refs.findIndex(r => r.entity === entityId && r.point === undefined);
  return bare === -1 ? null : refs[1 - bare];
}

function locusOf(kind: string, line: SolvedEntityView, other: SolverRef, model: SolvedSketchModel): Vec2 | null {
  switch (kind) {
    case 'coincident':
      return refPoint(model, other);
    case 'tangent': {
      const view = entityFor(model, other);
      return view ? tangencyPoint(line, view) : null;
    }
    case 'distance': {
      const point = refPoint(model, other);
      if (point) {
        return footOnLine(line, point);
      }
      const view = entityFor(model, other);
      if (!view) {
        return null;
      }
      const anchor = view.kind === 'line' ? lineMid(view) : view.center ?? null;
      return anchor ? footOnLine(line, anchor) : null;
    }
    default:
      return null;
  }
}

/**
 * Where a split would land for a cursor at `p`: the nearest point of the
 * entity — the foot on a line clamped to its segment, the circumference
 * point of an arc or circle. The hover marker of the Split tool. Null for
 * anything the tool cannot split, so nothing is promised.
 */
export function splitPointOn(view: SolvedEntityView, p: Vec2): Vec2 | null {
  switch (view.kind) {
    case 'line': {
      if (!view.start || !view.end) {
        return null;
      }
      const along = sub(view.end, view.start);
      const length = dist(view.start, view.end);
      if (length < 1e-9) {
        return null;
      }
      const rel = sub(p, view.start);
      const t = Math.max(0, Math.min(1, (rel[0] * along[0] + rel[1] * along[1]) / (length * length)));
      return add(view.start, scale(along, t));
    }
    case 'arc':
    case 'circle':
      return pointOnCircumference(view, p);
    default:
      return null;
  }
}
