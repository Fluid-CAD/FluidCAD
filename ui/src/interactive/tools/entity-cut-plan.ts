// What the Split and Trim tools' client-side plans share: why a pick cannot
// be cut, the entity's SOLVED geometry that goes on the wire (its literals
// are guesses), the nearest point of an entity to the cursor, and — for
// every constraint that addresses the whole entity and acts somewhere along
// it — the place it touches the entity, so the route can hand it to the
// piece that place falls on. The kernel cuts, the statement transforms
// rewrite; nothing geometric is decided here.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SplittableEntityParam } from '../../api';
import type { SolvedConstraintView, SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client/model';
import {
  add, dist, entityFor, footOnLine, lineMid, pointOnCircumference, refPoint, scale, sub, tangencyPoint,
  type Vec2,
} from '../../sketch-solver-client/resolve';
import { angleWithinSweep, arcSweep } from '../../sketch-solver-client/tessellate';
import type { SolvedPick } from '../sketch-hover-select-handler';

/** How a tool names itself in its refusals. */
export type CutWords = {
  /** The verb: "split", "trim". */
  verb: string;
  /** Its participle: "split", "trimmed". */
  past: string;
  /** The nudge when the pick carries no touch point. */
  where: string;
};

/** A whole-entity constraint and where it touches the entity. */
export type CutHint = { line: number; locus: Vec2 };

/** Why a pick cannot be cut, or null when it can. */
export function cutRefusalFor(pick: SolvedPick, words: CutWords): string | null {
  if (pick.datum !== undefined) {
    return `The sketch axes can't be ${words.past}`;
  }
  if (pick.role !== undefined) {
    return 'Click on the edge itself, not one of its points';
  }
  if (pick.reference) {
    return `A projected reference can't be ${words.past}`;
  }
  if (pick.copyInstance) {
    return `A copy can't be ${words.past} — ${words.verb} its source edge instead`;
  }
  if (pick.mirrorInstance) {
    return `A mirror image can't be ${words.past} — ${words.verb} its source edge instead`;
  }
  if (pick.anchor) {
    return pick.anchor.owner === 'text' ? `Text can't be ${words.past}` : `Bezier curves can't be ${words.past}`;
  }
  if (pick.kind === 'ellipse') {
    return `Ellipses can't be ${words.past} yet`;
  }
  if (pick.kind === 'point') {
    return `A point can't be ${words.past}`;
  }
  if (pick.sourceLocation?.occurrence !== undefined) {
    return 'This edge is drawn by a loop — edit the source instead';
  }
  if (pick.sourceLocation?.line === undefined) {
    return `This edge has no statement to ${words.verb}`;
  }
  if (!pick.at) {
    return words.where;
  }
  return null;
}

/** The solved geometry the kernel cuts, or null when the render did not carry it. */
export function entityGeometry(view: SolvedEntityView): SplittableEntityParam | null {
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
 * The nearest point of the entity to a cursor at `p`: the foot on a line
 * clamped to its segment, the circumference point of a circle, the
 * circumference point of an arc clamped to its drawn side (the nearer end
 * when the cursor sits beyond one). Null for anything the tools cannot
 * cut, so nothing is promised.
 */
export function pointOnEntity(view: SolvedEntityView, p: Vec2): Vec2 | null {
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
    case 'arc': {
      const on = pointOnCircumference(view, p);
      const arc = arcSweep(view);
      if (!on || !arc) {
        return null;
      }
      const angle = Math.atan2(on[1] - view.center![1], on[0] - view.center![0]);
      if (angleWithinSweep(arc.a0, arc.sweep, angle)) {
        return on;
      }
      return dist(on, view.start!) <= dist(on, view.end!) ? view.start! : view.end!;
    }
    case 'circle':
      return pointOnCircumference(view, p);
    default:
      return null;
  }
}

/**
 * Where each whole-entity constraint touches the entity: a point on it, a
 * tangency, the foot of a distance. The route resolves each to the piece it
 * falls on, so the constraint follows that piece — or goes with it.
 */
export function constraintHints(entity: SolvedEntityView, model: SolvedSketchModel): CutHint[] {
  const hints: CutHint[] = [];
  for (const c of model.constraints) {
    const statementLine = c.obj.sourceLocation?.line;
    if (statementLine === undefined) {
      continue;
    }
    const other = otherRefOf(c, entity.entityId);
    if (other === null) {
      continue;
    }
    const locus = locusOf(c.spec.kind, entity, other, model);
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

/** The point of the entity's carrier (its infinite line or full circle) nearest `p`. */
function nearestOnCarrier(entity: SolvedEntityView, p: Vec2): Vec2 | null {
  return entity.kind === 'line' ? footOnLine(entity, p) : pointOnCircumference(entity, p);
}

function locusOf(kind: string, entity: SolvedEntityView, other: SolverRef, model: SolvedSketchModel): Vec2 | null {
  switch (kind) {
    case 'coincident':
      return refPoint(model, other);
    case 'tangent': {
      const view = entityFor(model, other);
      return view ? tangencyPoint(entity, view) : null;
    }
    case 'distance': {
      const point = refPoint(model, other);
      if (point) {
        return nearestOnCarrier(entity, point);
      }
      const view = entityFor(model, other);
      if (!view) {
        return null;
      }
      const anchor = view.kind === 'line' ? lineMid(view) : view.center ?? null;
      return anchor ? nearestOnCarrier(entity, anchor) : null;
    }
    default:
      return null;
  }
}
