import { FeaturePanel } from './create-feature/feature-panel';
import { ExpressionRow } from './modify-pick/expression-row';
import { PickSlot, PickSlotChip } from './pick-slot';

/** The picker's standing instruction — edges and faces both project. */
const PICK_PROMPT = 'Pick edges or faces';

/**
 * The projection dialog: one multi-pick slot for the 3D edges and faces to
 * flatten onto the active sketch plane, Apply / Cancel, and the
 * expression-transparency row carrying the synthesized `project(…)` arguments
 * with their verified alternatives. Pure DOM + form state — the service owns
 * the pick set, the synthesis round-trips and the apply call.
 */
export class ProjectionPanel extends FeaturePanel {
  /** The chip at `index` asked to be removed. */
  onRemoveChip?: (index: number) => void;
  /** A chip row is hovered (its index) or left (null) — viewport previews. */
  onChipHover?: (index: number | null) => void;

  readonly expression: ExpressionRow;

  private readonly slot: PickSlot;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-projection-panel',
      title: 'Project',
      icon: '/icons/projection.png',
      exitLabel: 'Cancel',
      bodyHtml: '<div data-role="sources"></div>',
    });

    this.slot = new PickSlot(this.role('sources'), { label: 'Selection', multiple: true });
    // Picking is live the whole time the tool is armed, and the slot keeps
    // inviting more picks — it always wears the pick-target styling.
    this.slot.setArmed(true);
    this.slot.setPrompt(PICK_PROMPT);
    this.slot.onRemove = (index) => this.onRemoveChip?.(index);
    this.slot.onChipHover = (index) => this.onChipHover?.(index);

    // The expression row docks directly under the dialog body, above the
    // shell's message line — the modify dialog's stacking. The `contents`
    // wrapper only fixes the row's position in the column; it generates no box
    // of its own, so the row still participates in the column's flex gap.
    const exprHost = document.createElement('div');
    exprHost.className = 'contents';
    this.shell.column.insertBefore(exprHost, this.shell.column.children[1] ?? null);
    this.expression = new ExpressionRow(exprHost);
    this.expression.setPrefix('project(');
    this.expression.setSuffix(')');
    this.expression.onSubmit = () => this.onApply?.();
    // An open alternatives menu consumes Escape before the dialog does.
    this.shell.onEscape = () => {
      if (!this.expression.closeMenuIfOpen()) {
        this.onExit?.();
      }
    };
  }

  show(): void {
    this.setChips([]);
    this.setPrompt(null);
    this.setTitle(null);
    this.expression.hide();
    this.shell.show();
  }

  /** Retitle the dialog ("Edit projection"); null restores "Project". */
  setTitle(title: string | null): void {
    this.shell.setTitle(title);
  }

  /** Override the slot prompt (the edit mode's re-pick invitation); null restores the default. */
  setPrompt(text: string | null): void {
    this.slot.setPrompt(text ?? PICK_PROMPT);
  }

  override hide(): void {
    this.expression.hide();
    super.hide();
  }

  /**
   * The expression row is this dialog's preview (as in the modify dialog), so
   * the shell's preview line stays empty. A cleared preview folds the row;
   * successful ones arrive through {@link showExpression}, which carries the
   * args and their verified alternatives.
   */
  override setPreview(text: string | null): void {
    if (text === null) {
      this.hideExpression();
    }
  }

  showExpression(args: string, alternatives: string[]): void {
    this.expression.show(args, alternatives);
  }

  hideExpression(): void {
    this.expression.hide();
  }

  setChips(chips: PickSlotChip[]): void {
    this.slot.setChips(chips);
  }
}
