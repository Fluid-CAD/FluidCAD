import { iconUrl } from '../../ui/icon-url';
import { FeaturePanel } from './feature-panel';
import { OperandSlotControl, type OperandKind } from './operand-slot';
import type { DialogWidth } from './panel-controls';

/** One operand row of a dialog, as its panel declares it. */
export type OperandRowSpec<R extends string> = {
  /**
   * The row's name: it renders in the body's `data-role="<row>-slot"`
   * element, and every request carries its picks under it.
   */
  row: R;
  kind: OperandKind;
  label: string;
  /** What the row asks for while it holds nothing — a list keeps it under its chips. */
  prompt: string;
  /** What an Apply with the row empty is told. */
  empty: string;
};

/**
 * A control beside the operand rows that takes the armed border too
 * (Project's Direction, a {@link DirectionSlotControl}): a click on it arms
 * it, and the panel arms one row at a time.
 */
export type ArmableControl = {
  onArm?: () => void;
  onChange?: () => void;
  setArmed(armed: boolean): void;
  reset(): void;
};

/**
 * The panel of an operand-row dialog (Curves › Intersect, Curves › Project):
 * a {@link FeaturePanel} whose rows of curve or surface picks
 * ({@link OperandSlotControl}) are built from their declarations, with the
 * armed border kept across them and the rows a subclass adds beside them
 * ({@link armable}). One row is armed at a time — the primary border, where
 * viewport and timeline picks land; a click on a row arms it. The dialog
 * opens with the first operand row armed, and a pick in an operand row
 * hands the border to the next one while that one is empty
 * ({@link advanceFrom}); a row beside them is armed only by a click on it.
 *
 * A subclass declares its rows, lays them out in its body HTML (one under
 * another by default) and adds its options; it resets them with
 * {@link resetOptions}. Pure DOM state — the service owns the scene, the
 * previews and the apply call.
 */
export abstract class OperandRowPanel<R extends string, X extends string = never> extends FeaturePanel {
  /** Another row took the armed border — the service re-aims the viewer. */
  onArmedRowChange?: () => void;

  /** The operand rows, in declaration order. */
  readonly rows: readonly R[];
  private readonly specs = new Map<R, OperandRowSpec<R>>();
  private readonly slots = new Map<R, OperandSlotControl>();
  private readonly extras = new Map<X, ArmableControl>();
  private readonly editTitle: string;
  private armed: R | X;

  protected constructor(
    container: HTMLElement,
    opts: {
      /** The tool's id: the panel's element id and its icon derive from it. */
      id: string;
      title: string;
      /** The title over an edit of an existing statement. */
      editTitle: string;
      width?: DialogWidth;
      rows: readonly OperandRowSpec<R>[];
      /** The body, holding a `data-role="<row>-slot"` element per operand row; default: the rows one under another. */
      bodyHtml?: string;
    },
  ) {
    super(container, {
      id: `fluidcad-${opts.id}-panel`,
      title: opts.title,
      icon: iconUrl(opts.id),
      width: opts.width,
      bodyHtml: opts.bodyHtml ?? opts.rows.map(spec => `<div data-role="${spec.row}-slot"></div>`).join(''),
    });
    this.editTitle = opts.editTitle;
    this.rows = opts.rows.map(spec => spec.row);
    for (const spec of opts.rows) {
      this.specs.set(spec.row, spec);
      const control = new OperandSlotControl(this.role(`${spec.row}-slot`), {
        kind: spec.kind,
        label: spec.label,
        prompt: spec.prompt,
        multiple: true,
      });
      control.onArm = () => this.armRow(spec.row);
      control.onChange = () => this.onChange?.();
      this.slots.set(spec.row, control);
    }
    this.armed = this.rows[0];
  }

  /** The row picks land in. */
  get armedRow(): R | X {
    return this.armed;
  }

  /** The rows beside the operand rows, in the order they were added. */
  get extraRows(): readonly X[] {
    return [...this.extras.keys()];
  }

  /** The control of an operand row. */
  slot(row: R): OperandSlotControl {
    return this.slots.get(row);
  }

  /** `row` is one of the operand rows, not a row beside them. */
  isOperandRow(row: R | X): row is R {
    return this.rows.some(operand => operand === row);
  }

  /** What an Apply with the operand row empty is told. */
  emptyMessage(row: R): string {
    return this.specs.get(row).empty;
  }

  /** Create mode: every row empty, the options at their defaults, the first operand row armed. */
  show(): void {
    this.shell.setTitle(null);
    this.clearRows();
    this.resetOptions();
    this.armRow(this.rows[0]);
    this.shell.show();
  }

  /**
   * Edit mode: the service seeds the rows with the statement's own
   * arguments and the options as written; the first operand row opens
   * armed, a pick there replacing (or adding to) what the statement has.
   */
  showEdit(): void {
    this.shell.setTitle(this.editTitle);
    this.armRow(this.rows[0]);
    this.shell.show();
  }

  /** Arm one row: it wears the primary border and takes the next pick. */
  armRow(row: R | X): void {
    const changed = this.armed !== row;
    this.armed = row;
    for (const operand of this.rows) {
      this.slot(operand).setArmed(operand === row);
    }
    for (const [name, control] of this.extras) {
      control.setArmed(name === row);
    }
    if (changed) {
      this.onArmedRowChange?.();
    }
  }

  /**
   * A pick just landed in `row`: once it holds a pick, the next operand row
   * takes the armed border if it is empty, so the next click fills it. A
   * next row that holds something — picks, or an edit's own argument —
   * leaves `row` armed for more.
   */
  advanceFrom(row: R): void {
    const next = this.rows[this.rows.indexOf(row) + 1];
    if (next !== undefined && OperandRowPanel.holds(this.slot(row)) && OperandRowPanel.isEmpty(this.slot(next))) {
      this.armRow(next);
    }
  }

  /** Release the rows: no chips, and no consumed object kept drawn for them. */
  clearRows(): void {
    for (const row of this.rows) {
      this.slot(row).reset();
    }
    for (const control of this.extras.values()) {
      control.reset();
    }
  }

  /** The row holds at least one pick of its own. */
  static holds(slot: OperandSlotControl): boolean {
    const picks = slot.picks();
    return !('keep' in picks) && picks.picks.length > 0;
  }

  /** The row holds nothing: no pick, and no statement argument it keeps. */
  static isEmpty(slot: OperandSlotControl): boolean {
    const picks = slot.picks();
    return !('keep' in picks) && picks.picks.length === 0;
  }

  /** Create mode, after the rows emptied: the subclass's options back to their defaults. */
  protected resetOptions(): void {}

  /** Add a row beside the operand rows: a click on it arms it, a change in it is the panel's. */
  protected armable<C extends ArmableControl>(row: X, control: C): C {
    control.onArm = () => this.armRow(row);
    control.onChange = () => this.onChange?.();
    this.extras.set(row, control);
    return control;
  }
}
