// The sketch Trim tool's client-side plan (2D trim).
//
// A trim is one click on an edge: the segment of the edge between the
// nearest crossings on either side of the click goes away. The plan finds
// those crossings from the solved geometry (intersections.ts), names the
// piece the click sits on, names the entity each crossing belongs to (so
// the cut end can be pinned to it), and gathers the whole-entity constraint
// hints — see entity-cut-plan.ts for the parts the Split tool shares. The
// kernel cuts at the crossings and the statement transform deletes the
// piece.

import type { SolvedEmissionTargetParam, SplittableEntityParam } from '../../api';
import type { SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client/model';
import { entityIntersections, type Crossing } from '../../sketch-solver-client/intersections';
import { lineDir, type Vec2 } from '../../sketch-solver-client/resolve';
import { arcSweep, tessellateSolvedEntity } from '../../sketch-solver-client/tessellate';
import type { SolvedPick } from '../sketch-hover-select-handler';
import { constraintHints, cutRefusalFor, entityGeometry, pointOnEntity, type CutHint, type CutWords } from './entity-cut-plan';

const TRIM_WORDS: CutWords = { verb: 'trim', past: 'trimmed', where: 'Click the part of the edge to remove' };

const TAU = 2 * Math.PI;

/** The part of an edge a click removes. */
export type TrimSegment = {
  /**
   * The crossings bounding the segment, in the entity's travel order: none
   * when the whole entity goes, one when the segment runs to an end, two
   * when it lies between crossings. A circle's two cuts bound the segment
   * counter-clockwise from the first.
   */
  cuts: Vec2[];
  /**
   * Per cut, the entity crossing there as an emission target — the cut end
   * left behind is pinned to it — or null when nothing can be named (a
   * bezier curve, an ellipse, a looped statement).
   */
  cutters: (SolvedEmissionTargetParam | null)[];
  /** The index of the segment among the pieces the kernel cuts at `cuts`. */
  removed: number;
  /** The whole entity goes: nothing crosses it. */
  whole: boolean;
  /** The segment's polyline, for the hover preview. */
  points: Vec2[];
};

export type TrimRequest = {
  /** 1-indexed line of the entity statement. */
  line: number;
  entity: SplittableEntityParam;
  cuts: Vec2[];
  cutters: (SolvedEmissionTargetParam | null)[];
  removed: number;
  hints: CutHint[];
};

export type TrimPlan =
  | { ok: true; request: TrimRequest }
  | { ok: false; reason: string };

const refuse = (reason: string): TrimPlan => ({ ok: false, reason });

/** Why a pick cannot be trimmed, or null when it can. */
export function trimRefusalFor(pick: SolvedPick): string | null {
  return cutRefusalFor(pick, TRIM_WORDS);
}

/** The plan for a click. */
export function buildTrimPlan(pick: SolvedPick, model: SolvedSketchModel): TrimPlan {
  const refusal = trimRefusalFor(pick);
  if (refusal !== null) {
    return refuse(refusal);
  }
  const view = model.entities.get(pick.entityId);
  const entity = view ? entityGeometry(view) : null;
  const segment = view && entity ? trimSegmentOn(view, model, pick.at!) : null;
  if (!view || !entity || !segment) {
    return refuse("The edge's geometry is not available");
  }
  return {
    ok: true,
    request: {
      line: pick.sourceLocation!.line,
      entity,
      cuts: segment.cuts,
      cutters: segment.cutters,
      removed: segment.removed,
      hints: constraintHints(view, model),
    },
  };
}

/**
 * The segment of `view` a click at `p` removes: the stretch between the
 * nearest crossings before and after the click's projection onto the edge
 * — to an end where nothing crosses, the whole edge where nothing crosses
 * at all. Null for an entity the tool cannot trim.
 */
export function trimSegmentOn(view: SolvedEntityView, model: SolvedSketchModel, p: Vec2): TrimSegment | null {
  const at = pointOnEntity(view, p);
  if (!at) {
    return null;
  }
  const crossings = entityIntersections(view, model);
  switch (view.kind) {
    case 'line': {
      const dir = lineDir(view);
      return dir
        ? bounded(view, model, at, crossings, q => (q[0] - view.start![0]) * dir[0] + (q[1] - view.start![1]) * dir[1])
        : null;
    }
    case 'arc': {
      const arc = arcSweep(view);
      return arc ? bounded(view, model, at, crossings, q => arcTravel(view, arc.a0, view.cw === true, q)) : null;
    }
    case 'circle':
      return circleSegment(view, model, at, crossings);
    default:
      return null;
  }
}

/**
 * The segment of a line or arc around `at`, measured by `travel` (a
 * parameter increasing from the entity's start to its end): the nearest
 * crossing at or before the click bounds it on one side, the nearest after
 * on the other.
 */
function bounded(
  view: SolvedEntityView,
  model: SolvedSketchModel,
  at: Vec2,
  crossings: Crossing[],
  travel: (q: Vec2) => number,
): TrimSegment {
  const here = travel(at);
  let before: Crossing | null = null;
  let after: Crossing | null = null;
  for (const crossing of crossings) {
    const t = travel(crossing.point);
    if (t <= here) {
      if (before === null || t > travel(before.point)) {
        before = crossing;
      }
    } else if (after === null || t < travel(after.point)) {
      after = crossing;
    }
  }
  const bounds = [before, after].filter((c): c is Crossing => c !== null);
  const piece: SolvedEntityView = { ...view, start: before?.point ?? view.start, end: after?.point ?? view.end };
  return {
    cuts: bounds.map(c => c.point),
    cutters: bounds.map(c => cutterTarget(model, c)),
    removed: before === null ? 0 : 1,
    whole: bounds.length === 0,
    points: tessellateSolvedEntity(piece) ?? [],
  };
}

/**
 * How far around the arc (radians, along its sweep) a point on it lies from
 * the start. A point a rounding error before the start is at the start,
 * not a full turn past it.
 */
function arcTravel(view: SolvedEntityView, a0: number, cw: boolean, q: Vec2): number {
  const a = Math.atan2(q[1] - view.center![1], q[0] - view.center![0]);
  const rel = (((a - a0) % TAU) + TAU) % TAU;
  const travel = cw ? (TAU - rel) % TAU : rel;
  return travel > TAU - 1e-9 ? 0 : travel;
}

/**
 * The segment of a circle around `at`: the arc from the crossing before the
 * click to the crossing after it, going counter-clockwise. Fewer than two
 * crossings bound nothing, so the whole circle goes.
 */
function circleSegment(view: SolvedEntityView, model: SolvedSketchModel, at: Vec2, crossings: Crossing[]): TrimSegment {
  if (crossings.length < 2) {
    return { cuts: [], cutters: [], removed: 0, whole: true, points: tessellateSolvedEntity(view) ?? [] };
  }
  const angle = (q: Vec2): number => Math.atan2(q[1] - view.center![1], q[0] - view.center![0]);
  const here = angle(at);
  const ccwFrom = (from: number, to: number): number => (((to - from) % TAU) + TAU) % TAU;
  let prev = crossings[0];
  let next = crossings[0];
  for (const crossing of crossings) {
    if (ccwFrom(angle(crossing.point), here) < ccwFrom(angle(prev.point), here)) {
      prev = crossing;
    }
    if (ccwFrom(here, angle(crossing.point)) < ccwFrom(here, angle(next.point))) {
      next = crossing;
    }
  }
  const piece: SolvedEntityView = { ...view, kind: 'arc', start: prev.point, end: next.point, cw: false };
  return {
    cuts: [prev.point, next.point],
    cutters: [cutterTarget(model, prev), cutterTarget(model, next)],
    removed: 0,
    whole: false,
    points: tessellateSolvedEntity(piece) ?? [],
  };
}

/**
 * The entity a crossing belongs to, as the emission target the cut end is
 * pinned to: a T-junction names the end of it the crossing sits on. Null
 * when there is nothing a coincident can name — a bezier curve, an
 * ellipse, an anchor point, a looped statement.
 */
function cutterTarget(model: SolvedSketchModel, crossing: Crossing): SolvedEmissionTargetParam | null {
  if (crossing.entityId === null) {
    return null;
  }
  const view = model.entities.get(crossing.entityId);
  if (!view || view.anchor || view.kind === 'ellipse' || view.kind === 'point') {
    return null;
  }
  const target = entityTarget(model, view);
  return target && crossing.role !== undefined ? { ...target, role: crossing.role } : target;
}

/** An entity as an emission target: its statement, a reference's `.ref(i)`, a copy's instance, a mirror image's source chain. */
function entityTarget(model: SolvedSketchModel, view: SolvedEntityView): SolvedEmissionTargetParam | null {
  const loc = view.obj?.sourceLocation;
  if (!loc || loc.occurrence !== undefined) {
    return null;
  }
  if (view.reference) {
    return { line: loc.line, featureType: view.reference.producer, refIndex: view.reference.refIndex };
  }
  if (view.copyInstance) {
    return { line: loc.line, featureType: 'copy', instanceIndex: view.copyInstance.slot };
  }
  if (view.mirrorInstance) {
    const source = model.entities.get(view.mirrorInstance.sourceEntityId);
    const nested = source ? entityTarget(model, source) : null;
    return nested ? { line: loc.line, featureType: 'mirror', source: nested } : null;
  }
  if (view.kind !== 'line' && view.kind !== 'arc' && view.kind !== 'circle') {
    return null;
  }
  return { line: loc.line, featureType: view.kind };
}
