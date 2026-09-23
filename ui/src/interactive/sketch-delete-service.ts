import { deleteSketchEntities } from '../api';
import { buildSettleWriteBack } from '../sketch-solver-client/write-back';
import type { SceneObjectRender } from '../types';
import type { SketchClickOpRail } from './sketch-click-op-service';
import { buildDeletePlan, describeDependents, type DeletePlan } from './tools/delete-plan';

/** The Delete key's window onto the sketch session it acts in. */
export type SketchDeleteRail = Pick<SketchClickOpRail, 'model' | 'sketch' | 'clearSelection' | 'message' | 'noteEdit'> & {
  /** The hover handler's selected edge shape ids. */
  selectedShapeIds(): readonly string[];
  sceneObjects(): readonly SceneObjectRender[];
  /**
   * Whether the selection is the user's own — no drawing tool armed, no
   * op dialog or click tool open. A tool's picks are its input, never a
   * delete target.
   */
  idle(): boolean;
};

/**
 * The sketcher's Delete key (and the constraint bar's Delete button when
 * edges are picked): the selected edges' statements go in one edit. The
 * server takes the constraints naming them and the statements that
 * consumed them along, and lets geometry that borrowed one of their points
 * keep its place; the re-render speaks for a landed edit, a toast for a
 * refusal or for dependents that went too.
 */
export class SketchDeleteService {
  /** An edit in flight — a second press must not race the first. */
  private busy = false;

  constructor(private readonly rail: SketchDeleteRail) {}

  /**
   * What Delete would do for the current edge selection, or null when no
   * edge is selected or a tool owns the selection.
   */
  plan(): DeletePlan | null {
    if (!this.rail.idle()) {
      return null;
    }
    return buildDeletePlan(this.rail.selectedShapeIds(), this.rail.sceneObjects());
  }

  /** Delete the selected edges' statements; resolves once the edit landed or was refused. */
  async run(): Promise<void> {
    if (this.busy) {
      return;
    }
    const plan = this.plan();
    if (!plan) {
      return;
    }
    if (plan.ok === false) {
      this.rail.message(plan.reason);
      return;
    }
    const sketch = this.rail.sketch();
    if (!sketch) {
      this.rail.message('Delete needs an active sketch');
      return;
    }
    // The literals are guesses; a point another statement borrows from a
    // deleted entity is written as that entity's literal. Settling every
    // drifted guess on its solved position in the same edit keeps the
    // survivors where the user saw them.
    const model = this.rail.model();
    const settle = model ? buildSettleWriteBack(model).edits : [];
    this.busy = true;
    try {
      const result = await deleteSketchEntities({
        ...sketch,
        lines: plan.targets.map(target => target.line),
        ...(settle.length > 0 ? { settle } : {}),
      });
      if (!result.success) {
        this.rail.message(result.reason ?? 'The delete was refused');
        return;
      }
      this.rail.clearSelection();
      this.rail.noteEdit({});
      const dependents = result.dependents ?? [];
      if (dependents.length > 0) {
        this.rail.message(describeDependents(dependents));
      }
    } finally {
      this.busy = false;
    }
  }
}
