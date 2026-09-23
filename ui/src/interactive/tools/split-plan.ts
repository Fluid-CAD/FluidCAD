// The sketch Split tool's client-side plan (2D split).
//
// A split is one click on an edge. The plan gathers which statement the
// edge belongs to, its solved geometry, where the cut lands (a snap mark or
// the click's projection) and the whole-line constraint hints — see
// entity-cut-plan.ts for the parts the Trim tool shares.

import type { SplittableEntityParam } from '../../api';
import type { SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client/model';
import { arcMidPoint, dist, lineMid, type Vec2 } from '../../sketch-solver-client/resolve';
import type { SolvedPick } from '../sketch-hover-select-handler';
import { constraintHints, cutRefusalFor, entityGeometry, pointOnEntity, type CutHint, type CutWords } from './entity-cut-plan';

/** How close (screen px) the free cut point must come to a snap mark to lock onto it. */
export const SPLIT_SNAP_PX = 10;

const SPLIT_WORDS: CutWords = { verb: 'split', past: 'split', where: 'Click on the edge where it should split' };

/** Where the cut would land for the cursor: at a snap mark, or free along the edge. */
export type SplitTarget = { at: Vec2; snapped: boolean };

export type SplitRequest = {
  /** 1-indexed line of the entity statement. */
  line: number;
  entity: SplittableEntityParam;
  /** Where the click landed, sketch-local. */
  at: Vec2;
  hints: CutHint[];
};

export type SplitPlan =
  | { ok: true; request: SplitRequest }
  | { ok: false; reason: string };

const refuse = (reason: string): SplitPlan => ({ ok: false, reason });

/** Why a pick cannot be split, or null when it can. */
export function splitRefusalFor(pick: SolvedPick): string | null {
  return cutRefusalFor(pick, SPLIT_WORDS);
}

/**
 * The plan for a click. `snapTolerance` (sketch units) is the reach of the
 * snap marks — the same one the hover marker used, so the cut lands where
 * the marker showed it; 0 splits exactly at the click's projection.
 */
export function buildSplitPlan(pick: SolvedPick, model: SolvedSketchModel, snapTolerance = 0): SplitPlan {
  const refusal = splitRefusalFor(pick);
  if (refusal !== null) {
    return refuse(refusal);
  }
  const view = model.entities.get(pick.entityId);
  const entity = view ? entityGeometry(view) : null;
  if (!view || !entity) {
    return refuse("The edge's geometry is not available");
  }
  const target = splitTargetOn(view, pick.at!, snapTolerance);
  if (!target) {
    return refuse("The edge's geometry is not available");
  }
  return {
    ok: true,
    request: {
      line: pick.sourceLocation!.line,
      entity,
      at: target.at,
      // Only lines need hints: the pieces of an arc or circle ride one
      // circle (the junction and center coincidents pin them), so every
      // constraint on the circle's geometry keeps its meaning on the first
      // piece. A line's pieces can bend at the junction, so a point on the
      // line, a tangency or a distance belongs with the piece it sits on.
      hints: view.kind === 'line' ? constraintHints(view, model) : [],
    },
  };
}

/** Where a split would land for a cursor at `p` — see {@link pointOnEntity}. */
export const splitPointOn = pointOnEntity;

/**
 * The places a split likes to land: the midpoint of a line, the midpoint
 * of an arc (on its drawn side), and the four quarter marks of a circle
 * (where the sketch axes' directions cross it). Empty for anything else.
 */
export function splitSnapPoints(view: SolvedEntityView): Vec2[] {
  switch (view.kind) {
    case 'line': {
      const m = lineMid(view);
      return m ? [m] : [];
    }
    case 'arc': {
      const m = arcMidPoint(view);
      return m ? [m] : [];
    }
    case 'circle': {
      if (!view.center || view.radius === undefined) {
        return [];
      }
      const [cx, cy] = view.center;
      const r = view.radius;
      return [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
    }
    default:
      return [];
  }
}

/**
 * Where a split lands for a cursor at `p`: the nearest snap mark when the
 * free cut point ({@link splitPointOn}) comes within `snapTolerance` of
 * one, else the free point itself. Null when the entity cannot be split.
 */
export function splitTargetOn(view: SolvedEntityView, p: Vec2, snapTolerance: number): SplitTarget | null {
  const free = splitPointOn(view, p);
  if (!free) {
    return null;
  }
  let best: Vec2 | null = null;
  let bestDist = snapTolerance;
  for (const mark of splitSnapPoints(view)) {
    const d = dist(free, mark);
    if (d <= bestDist) {
      best = mark;
      bestDist = d;
    }
  }
  return best ? { at: best, snapped: true } : { at: free, snapped: false };
}
