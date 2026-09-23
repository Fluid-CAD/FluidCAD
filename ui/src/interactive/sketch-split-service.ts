import { splitSketchEntity } from '../api';
import type { SolvedEntityView, SolvedSketchModel } from '../sketch-solver-client/model';
import type { SolvedPick } from './sketch-hover-select-handler';
import type { SketchOpDialog } from './sketch-op-service';
import { buildSplitPlan, splitRefusalFor, splitTargetOn, type SplitTarget } from './tools/split-plan';

/** The Split tool's window onto the sketch session it acts in. */
export type SketchSplitRail = {
  /** The hover handler's ordered picks (the click that just landed is last). */
  picks(): SolvedPick[];
  model(): SolvedSketchModel | null;
  /** The active sketch's file and statement line; null outside a sketch. */
  sketch(): { filePath: string; sketchLine: number } | null;
  /** The snap marks' reach in sketch units at the current zoom (SPLIT_SNAP_PX). */
  snapTolerance(): number;
  clearSelection(): void;
  /** The transient toast under the navbar. */
  message(text: string): void;
  /** An edit landed — the sketch statement's post-edit line, when it moved. */
  noteEdit(result: { sketchLine?: number }): void;
};

/**
 * The sketch toolbar's Split tool: one click on an edge cuts it there. No
 * dialog — picking IS the input, so the tool rides the op-dialog surface
 * (the hover handler stays active and every selection change reaches
 * {@link refresh}). The click's own pick carries the statement and the
 * touch point; the plan gathers the solved geometry and the constraint
 * loci; the server cuts (kernel), rewrites (statement transform) and
 * reports what it removed.
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
export class SketchSplitService implements SketchOpDialog {
  onVisibilityChange?: (visible: boolean) => void;

  private active = false;
  /** A split in flight — a second click must not race the first edit. */
  private busy = false;

  constructor(private readonly rail: SketchSplitRail) {}

  get isActive(): boolean {
    return this.active;
  }

  get isEditing(): boolean {
    return false;
  }

  get isAwaitingSketch(): boolean {
    return false;
  }

  noteSketchActive(): void {}

  enter(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.rail.clearSelection();
    this.rail.message('Click an edge where it should split');
  }

  exit(): void {
    this.active = false;
  }

  refresh(): void {
    if (!this.active || this.busy) {
      return;
    }
    const picks = this.rail.picks();
    const pick = picks[picks.length - 1];
    if (!pick) {
      return;
    }
    void this.split(pick);
  }

  private async split(pick: SolvedPick): Promise<void> {
    const model = this.rail.model();
    const sketch = this.rail.sketch();
    if (!model || !sketch) {
      this.rail.clearSelection();
      this.rail.message('Split needs a constrained sketch');
      return;
    }
    const plan = buildSplitPlan(pick, model, this.rail.snapTolerance());
    if (plan.ok === false) {
      this.rail.clearSelection();
      this.rail.message(plan.reason);
      return;
    }
    this.busy = true;
    try {
      const result = await splitSketchEntity({
        sketchLine: sketch.sketchLine,
        filePath: sketch.filePath,
        ...plan.request,
      });
      this.rail.clearSelection();
      // A landed split speaks through the re-render (the new vertex, the
      // pieces in the timeline); only a refusal needs words.
      if (result.success) {
        this.rail.noteEdit({ sketchLine: result.sketchLine });
      } else {
        this.rail.message(result.reason ?? 'the split was refused');
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * The hover preview: where the cut would land for the cursor at `at` on
   * the hovered entity, and whether it locked onto a snap mark — null for
   * an entity the tool would refuse, so the marker never promises a split
   * that cannot happen.
   */
  markerFor(entity: SolvedEntityView, at: [number, number]): SplitTarget | null {
    if (!this.active || this.busy) {
      return null;
    }
    const refusal = splitRefusalFor({
      entityId: entity.entityId,
      kind: entity.kind,
      sourceLocation: entity.obj?.sourceLocation,
      at,
      ...(entity.reference ? { reference: entity.reference } : {}),
      ...(entity.copyInstance ? { copyInstance: entity.copyInstance } : {}),
      ...(entity.anchor ? { anchor: entity.anchor } : {}),
    });
    return refusal === null ? splitTargetOn(entity, at, this.rail.snapTolerance()) : null;
  }
}
