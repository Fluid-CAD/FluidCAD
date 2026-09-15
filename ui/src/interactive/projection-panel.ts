import type { ProjectionOp } from '../api';
import { FeaturePanel } from './create-feature/feature-panel';
import { ExpressionRow } from './modify-pick/expression-row';
import { PickSlot, PickSlotChip } from './pick-slot';
import { PROJECTION_OP_SPECS, ProjectionOpSpec } from './projection-op';

/**
 * The projection dialog: one multi-pick slot for the 3D edges and faces to
 * flatten onto the active sketch plane, Apply / Cancel, and the
 * expression-transparency row carrying the synthesized `project(…)` arguments
 * with their verified alternatives. The same dialog serves `intersect()` —
 * {@link setOp} swaps the title, icon, prompts and expression prefix. Pure
 * DOM + form state — the service owns the pick set, the synthesis
 * round-trips and the apply call.
 */
export class ProjectionPanel extends FeaturePanel {
  /** The chip at `index` asked to be removed. */
  onRemoveChip?: (index: number) => void;
  /** A chip row is hovered (its index) or left (null) — viewport previews. */
  onChipHover?: (index: number | null) => void;
  /** The cross-part notice's Confirm button. */
  onConfirmForeign?: () => void;

  readonly expression: ExpressionRow;

  private readonly slot: PickSlot;
  private readonly foreignRow: HTMLDivElement;
  private readonly foreignText: HTMLParagraphElement;
  private readonly foreignConfirm: HTMLButtonElement;
  /** The statement the dialog currently writes; everything op-specific reads off it. */
  private spec: ProjectionOpSpec = PROJECTION_OP_SPECS.project;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-projection-panel',
      title: PROJECTION_OP_SPECS.project.title,
      icon: PROJECTION_OP_SPECS.project.icon,
      exitLabel: 'Cancel',
      bodyHtml: `
        <div data-role="sources"></div>
        <div data-role="foreign" class="hidden rounded-lg border border-base-300 bg-base-200/60 px-3 py-2 text-xs leading-snug">
          <p data-role="foreign-text" class="text-base-content/80 m-0"></p>
          <button data-role="foreign-confirm" class="btn btn-primary btn-xs mt-2">Expose and project</button>
        </div>
      `,
    });

    // The cross-part notice: a soft row under the picks (not the shell's red
    // message line — nothing is wrong), with the go-ahead Apply waits for.
    this.foreignRow = this.role<HTMLDivElement>('foreign');
    this.foreignText = this.role<HTMLParagraphElement>('foreign-text');
    this.foreignConfirm = this.role<HTMLButtonElement>('foreign-confirm');
    this.foreignConfirm.addEventListener('click', () => this.onConfirmForeign?.());

    this.slot = new PickSlot(this.role('sources'), { label: 'Selection', multiple: true });
    // Picking is live the whole time the tool is armed, and the slot keeps
    // inviting more picks — it always wears the pick-target styling.
    this.slot.setArmed(true);
    this.slot.setPrompt(this.spec.pickPrompt);
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

  /**
   * Dress the dialog for `op` — call before {@link show}. Title, icon, slot
   * prompt, the cross-part button's label and the expression row's callee
   * prefix all follow the statement being written.
   */
  setOp(op: ProjectionOp): void {
    this.spec = PROJECTION_OP_SPECS[op];
    this.shell.setIcon(this.spec.icon);
    this.foreignConfirm.textContent = this.spec.confirmLabel;
    this.expression.setPrefix(`${op}(`);
  }

  show(): void {
    this.setChips([]);
    this.setPrompt(null);
    this.setTitle(null);
    this.setForeignNotice(null);
    this.expression.hide();
    this.shell.show();
  }

  /**
   * The cross-part notice: the text and, until confirmed, the Confirm
   * button; null hides the row.
   */
  setForeignNotice(notice: { text: string; confirmed: boolean } | null): void {
    if (!notice) {
      this.foreignRow.classList.add('hidden');
      this.foreignText.textContent = '';
      return;
    }
    this.foreignText.textContent = notice.text;
    this.foreignConfirm.classList.toggle('hidden', notice.confirmed);
    this.foreignRow.classList.remove('hidden');
  }

  /** Retitle the dialog ("Edit projection"); null restores the op's own title. */
  setTitle(title: string | null): void {
    this.shell.setTitle(title ?? this.spec.title);
  }

  /** Override the slot prompt (the edit mode's re-pick invitation); null restores the op's default. */
  setPrompt(text: string | null): void {
    this.slot.setPrompt(text ?? this.spec.pickPrompt);
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
