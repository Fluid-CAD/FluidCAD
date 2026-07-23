import { applyProject, ApplyFeatureEntity, SketchSourceRef } from '../api';
import { SceneObjectRender, SubSelection } from '../types';
import { SelectedEntity, Viewer } from '../viewer';
import { ApplyRunner } from './create-feature/apply-runner';
import { SketchUISuspender } from './create-feature/sketch-suspender';
import { PickSelection } from './pick-selection';
import { ProjectionPanel } from './projection-panel';

/** The apply payload: the picks plus the sketch body receiving the call. */
type ProjectRequest = { entities: ApplyFeatureEntity[]; sketch: SketchSourceRef };

/**
 * The Project sketch tool: flatten 3D edges and faces onto the plane of the
 * sketch being edited. Arming it leaves sketch editing (the camera unlocks
 * from the sketch normal and clicks reach the solids again), then every click
 * toggles an edge or a face into the pick set. The selection is explained by
 * the same synthesis the modify tools use — the dialog's expression row shows
 * the winning `project(…)` arguments and its verified alternatives, editable
 * in place. Apply writes the statement into the sketch's own body; Cancel
 * touches no code and hands the viewport back to the sketch.
 */
export class ProjectionPickService {
  /**
   * The tool finished (applied or cancelled) — the toolbar disarms it, which
   * comes back through {@link exit} with these options.
   */
  onDone?: (opts?: { resume?: 'immediate' | 'lazy' }) => void;
  /**
   * Fired on enter/exit. The dialog docks in the sketch dialog's spot, so the
   * toolbar service wires this to suspend the sketch dialog while it is open
   * and restore it after — the same contract as the 2D op dialogs.
   */
  onVisibilityChange?: (visible: boolean) => void;

  private readonly panel: ProjectionPanel;
  private readonly sketchUI: SketchUISuspender;
  private readonly selection = new PickSelection();
  private readonly runner: ApplyRunner<ProjectRequest>;
  /** The sketch receiving the projection, or null while disarmed. */
  private sketch: SketchSourceRef | null = null;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    hooks: { onSuspendSketchUI?: () => void; onResumeSketchUI?: () => void } = {},
  ) {
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new ProjectionPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.onDone?.();
    this.panel.onRemoveChip = (index) => this.removeChip(index);
    this.panel.onChipHover = (index) => this.previewChip(index);

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.isPicking,
      build: () => this.buildRequest(),
      send: (request, extras) => applyProject(request.entities, request.sketch, {
        chains: this.selection.apiChains(),
        selectorOverride: this.selectorOverride(),
        ...extras,
      }),
      onApplied: () => this.onDone?.({ resume: 'lazy' }),
      failMessage: () => 'Could not apply the projection.',
      onPreviewSuccess: (result) => {
        this.panel.setMessage(null);
        this.panel.showExpression(result.args ?? '', result.alternatives ?? []);
      },
    });
  }

  /** Armed and consuming viewport clicks. */
  get isPicking(): boolean {
    return this.sketch !== null;
  }

  /** True while the armed tool has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Arm the tool over the sketch being edited. Composing a projection means
   * looking at the solids, not down the sketch plane, so sketch editing is
   * suspended right away — Cancel resumes it, an Apply's re-render takes over.
   */
  enter(sketch: SketchSourceRef): void {
    if (this.isPicking) {
      return;
    }
    this.sketch = sketch;
    this.selection.clear();
    this.sketchUI.suspend();
    // Both kinds project, and sketch wires stay out of it — the sources are
    // the solids around the sketch, not the sketch's own geometry.
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.panel.show();
    this.onVisibilityChange?.(true);
  }

  /**
   * `resume: 'lazy'` gives sketch editing back without forcing the mode
   * transition — for apply-success and for exits driven by something else
   * taking the viewport (another dialog arming, the sketch going away), where
   * a forced re-render would fight the view that caller is installing. User
   * cancels resume immediately.
   */
  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    if (!this.isPicking) {
      return;
    }
    this.sketch = null;
    this.selection.clear();
    this.runner.cancelPreview();
    this.panel.hide();
    this.viewer.clearHighlight();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
    this.onVisibilityChange?.(false);
  }

  /**
   * A render landed while the tool is armed: shape ids changed with it, so
   * the picks no longer address anything and drop back to the prompt (the
   * wrap dialog's behavior for its target face).
   */
  update(_sceneObjects: SceneObjectRender[]): void {
    if (!this.isPicking || this.selection.isEmpty) {
      return;
    }
    this.selection.clear();
    this.viewer.clearHighlight();
    this.panel.setMessage('The code changed — the picked geometry was reset.');
    this.refresh();
  }

  /** A viewport click while armed: the pick toggles into the source set. */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isPicking || !shapeId || !sub || (sub.type !== 'edge' && sub.type !== 'face')) {
      return;
    }
    this.panel.setMessage(null);
    this.selection.toggle({ shapeId, sub });
    this.refresh();
  }

  /** The request for the current pick set, or the message blocking it. */
  private buildRequest(): ProjectRequest | { error: string } {
    if (!this.sketch) {
      return { error: 'No sketch to project into.' };
    }
    if (this.selection.isEmpty) {
      return { error: 'Pick the edges or faces to project.' };
    }
    return { entities: this.selection.entities, sketch: this.sketch };
  }

  /** The hand-edited argument list, or undefined while it matches synthesis. */
  private selectorOverride(): string | undefined {
    const edited = this.panel.expression.value;
    const synthesized = this.panel.expression.synthesizedArgs;
    return edited !== '' && synthesized !== null && edited !== synthesized ? edited : undefined;
  }

  private removeChip(index: number): void {
    const row = this.selection.chipRows()[index];
    if (!row) {
      return;
    }
    // A row toggles off exactly as a viewport click on its entity would.
    this.selection.toggle(row.members[0]);
    this.refresh();
  }

  /** Chip hover: light up just that row's entities until the pointer leaves. */
  private previewChip(index: number | null): void {
    if (!this.isPicking) {
      return;
    }
    const row = index === null ? null : this.selection.chipRows()[index];
    this.highlight(row ? row.members : this.selection.entities);
  }

  private refresh(): void {
    this.panel.setChips(this.selection.chipRows().map(row => ({
      label: row.label,
      badge: '●',
      removable: true,
    })));
    this.highlight(this.selection.entities);
    if (this.selection.isEmpty) {
      // Nothing to synthesize — fold the row now instead of after a debounce.
      this.runner.cancelPreview();
      this.panel.hideExpression();
      return;
    }
    this.runner.schedulePreview();
  }

  private highlight(entities: SelectedEntity[]): void {
    if (entities.length > 0) {
      this.viewer.highlightEntities(entities);
    } else {
      this.viewer.clearHighlight();
    }
  }
}
