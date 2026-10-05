import type { SketchPositionEditParam } from '../api';
import type { SolvedEntityView, SolvedSketchModel } from '../sketch-solver-client/model';
import { pickForEntity } from '../sketch-solver-client/model';
import { buildSettleWriteBack } from '../sketch-solver-client/write-back';
import type { HoverPreview, SolvedPick } from './sketch-hover-select-handler';
import type { SketchOpDialog } from './sketch-op-service';

/** A click tool's window onto the sketch session it acts in. */
export type SketchClickOpRail = {
  /** The hover handler's ordered picks (the click that just landed is last). */
  picks(): SolvedPick[];
  model(): SolvedSketchModel | null;
  /** The active sketch's file and statement line; null outside a sketch. */
  sketch(): { filePath: string; sketchLine: number } | null;
  clearSelection(): void;
  /** The transient toast under the navbar. */
  message(text: string): void;
  /** An edit landed — the sketch statement's post-edit line, when it moved. */
  noteEdit(result: { sketchLine?: number }): void;
};

/** What the tool would send for a pick, or why it will not. */
export type ClickOpPlan<Request> =
  | { ok: true; request: Request }
  | { ok: false; reason: string };

/** What the server made of the request. */
export type ClickOpOutcome = { success: boolean; reason?: string; sketchLine?: number };

/**
 * Where a request lands: the active sketch, plus the settle write-back
 * (see `buildSettleWriteBack`) the server applies before cutting so the
 * source it cuts is already at rest.
 */
export type ClickOpTarget = { filePath: string; sketchLine: number; settle?: SketchPositionEditParam[] };

/**
 * A sketch toolbar tool whose whole input is one click on an edge (Split,
 * Trim). No dialog — picking IS the input, so the tool rides the op-dialog
 * surface (the hover handler stays active and every selection change
 * reaches {@link refresh}). The click's own pick carries the statement and
 * the touch point; the tool's {@link plan} gathers what the server needs
 * from the solved model, {@link send} posts it, and the re-render speaks
 * for a landed edit — only a refusal needs words.
 *
 * While armed, the tool also previews on hover what the click would do
 * ({@link previewFor}), never promising an edit its plan would refuse.
 */
export abstract class SketchClickOpService<Request> implements SketchOpDialog {
  onVisibilityChange?: (visible: boolean) => void;

  private active = false;
  /** An edit in flight — a second click must not race the first. */
  private busy = false;

  constructor(
    protected readonly rail: SketchClickOpRail,
    private readonly label: string,
    private readonly prompt: string,
  ) {}

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
    this.rail.message(this.prompt);
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
    if (pick) {
      void this.run(pick);
    }
  }

  /**
   * The hover preview for the cursor at `at` on `entity` — null when the
   * tool is not idle or would refuse the entity, so the preview never
   * promises an edit that cannot happen.
   */
  previewFor(entity: SolvedEntityView, at: [number, number], model: SolvedSketchModel): HoverPreview | null {
    if (!this.active || this.busy || this.refusalFor({ ...pickForEntity(model, entity), at }) !== null) {
      return null;
    }
    return this.preview(entity, at, model);
  }

  /** Why the tool declines a pick, or null. */
  protected abstract refusalFor(pick: SolvedPick): string | null;

  /** The request for a click, from the solved model. */
  protected abstract plan(pick: SolvedPick, model: SolvedSketchModel): ClickOpPlan<Request>;

  /** Post the request against the active sketch. */
  protected abstract send(request: Request, target: ClickOpTarget): Promise<ClickOpOutcome>;

  /** The preview for an entity the tool would accept. */
  protected abstract preview(entity: SolvedEntityView, at: [number, number], model: SolvedSketchModel): HoverPreview | null;

  private async run(pick: SolvedPick): Promise<void> {
    const model = this.rail.model();
    const sketch = this.rail.sketch();
    if (!model || !sketch) {
      this.rail.clearSelection();
      this.rail.message(`${this.label} needs a constrained sketch`);
      return;
    }
    const plan = this.plan(pick, model);
    if (plan.ok === false) {
      this.rail.clearSelection();
      this.rail.message(plan.reason);
      return;
    }
    // The literals are guesses; the cut's literals come from the solved
    // geometry. Settling every drifted guess on its solved position in the
    // same edit keeps the two consistent, so nothing jumps on the re-solve.
    const { edits: settle } = buildSettleWriteBack(model);
    this.busy = true;
    try {
      const result = await this.send(plan.request, { ...sketch, ...(settle.length > 0 ? { settle } : {}) });
      this.rail.clearSelection();
      if (result.success) {
        this.rail.noteEdit({ sketchLine: result.sketchLine });
      } else {
        this.rail.message(result.reason ?? `the ${this.label.toLowerCase()} was refused`);
      }
    } finally {
      this.busy = false;
    }
  }
}
