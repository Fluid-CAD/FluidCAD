import { trimSketchEntity } from '../api';
import type { SolvedEntityView, SolvedSketchModel } from '../sketch-solver-client/model';
import type { HoverPreview, SolvedPick } from './sketch-hover-select-handler';
import {
  SketchClickOpService, type ClickOpOutcome, type ClickOpPlan, type ClickOpTarget, type SketchClickOpRail,
} from './sketch-click-op-service';
import { buildTrimPlan, trimRefusalFor, trimSegmentOn, type TrimRequest } from './tools/trim-plan';

/**
 * The sketch toolbar's Trim tool: one click on an edge removes the part of
 * it between the nearest crossings on either side of the click — up to an
 * end where nothing crosses, the whole edge where nothing crosses at all.
 * The hover preview draws that part in the removal colour. The plan finds
 * the crossings from the solved model; the server cuts (kernel), deletes
 * the piece (statement transform) and reports the constraints that went.
 *
 * What trims: a `line()`, an `arc()` (into one shorter arc, or two arcs on
 * one circle), a `circle()` (into one arc, or deleted). What refuses, with
 * a toast: text, beziers, ellipses (not yet), points, projected references,
 * copy and mirror images, looped statements, and a click on a vertex.
 */
export class SketchTrimService extends SketchClickOpService<TrimRequest> {
  constructor(rail: SketchClickOpRail) {
    super(rail, 'Trim', 'Click the part of an edge to remove');
  }

  protected refusalFor(pick: SolvedPick): string | null {
    return trimRefusalFor(pick);
  }

  protected plan(pick: SolvedPick, model: SolvedSketchModel): ClickOpPlan<TrimRequest> {
    return buildTrimPlan(pick, model);
  }

  protected send(request: TrimRequest, target: ClickOpTarget): Promise<ClickOpOutcome> {
    return trimSketchEntity({ ...target, ...request });
  }

  /** The stretch of the edge the click would remove. */
  protected preview(entity: SolvedEntityView, at: [number, number], model: SolvedSketchModel): HoverPreview | null {
    const segment = trimSegmentOn(entity, model, at);
    return segment && segment.points.length > 1 ? { kind: 'segment', points: segment.points } : null;
  }
}
