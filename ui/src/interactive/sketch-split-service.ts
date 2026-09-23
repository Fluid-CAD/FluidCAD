import { splitSketchEntity } from '../api';
import type { SolvedEntityView, SolvedSketchModel } from '../sketch-solver-client/model';
import type { HoverPreview, SolvedPick } from './sketch-hover-select-handler';
import {
  SketchClickOpService, type ClickOpOutcome, type ClickOpPlan, type ClickOpTarget, type SketchClickOpRail,
} from './sketch-click-op-service';
import { buildSplitPlan, splitRefusalFor, splitTargetOn, type SplitRequest } from './tools/split-plan';

/** The Split tool's rail: the click rail plus the snap marks' reach. */
export type SketchSplitRail = SketchClickOpRail & {
  /** The snap marks' reach in sketch units at the current zoom (SPLIT_SNAP_PX). */
  snapTolerance(): number;
};

/**
 * The sketch toolbar's Split tool: one click on an edge cuts it there. The
 * plan gathers the solved geometry and the constraint loci; the server cuts
 * (kernel), rewrites (statement transform) and reports what it removed.
 *
 * What splits: a `line()` into two lines, an `arc()` into two arcs around
 * the same center, a `circle()` into one full-turn arc. What refuses, with
 * a toast: text, beziers, ellipses (not yet), points, projected references,
 * copy and mirror images, looped statements, and a click on a vertex.
 *
 * The cut point snaps to a line's midpoint, an arc's midpoint and a
 * circle's four quarter marks; the hover marker and the click share one
 * tolerance, so the split lands exactly where the marker showed it.
 */
export class SketchSplitService extends SketchClickOpService<SplitRequest> {
  private readonly snapTolerance: () => number;

  constructor(rail: SketchSplitRail) {
    super(rail, 'Split', 'Click an edge where it should split');
    this.snapTolerance = rail.snapTolerance;
  }

  protected refusalFor(pick: SolvedPick): string | null {
    return splitRefusalFor(pick);
  }

  protected plan(pick: SolvedPick, model: SolvedSketchModel): ClickOpPlan<SplitRequest> {
    return buildSplitPlan(pick, model, this.snapTolerance());
  }

  protected send(request: SplitRequest, target: ClickOpTarget): Promise<ClickOpOutcome> {
    return splitSketchEntity({ ...target, ...request });
  }

  /** Where the cut would land, and whether it locked onto a snap mark. */
  protected preview(entity: SolvedEntityView, at: [number, number]): HoverPreview | null {
    const target = splitTargetOn(entity, at, this.snapTolerance());
    return target ? { kind: 'point', ...target } : null;
  }
}
