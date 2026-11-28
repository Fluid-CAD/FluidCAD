import type { VariableInfo } from '../../ui/expression-core';
import type { ExpressionField } from '../../ui/expression-field';
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
 * A control beside the operand rows that joins their hand-on (Bridge's
 * From and To, an {@link EndSlotControl}): it says what it holds, so a pick
 * in the row before it can hand it the border while it is empty, and a
 * pick in it can hand the border on.
 */
export type HandingControl = ArmableControl & {
  /** It holds a pick of its own, not only an edit's own argument. */
  holds(): boolean;
  /** It holds nothing: no pick, and no statement argument it keeps. */
  isEmpty(): boolean;
};

/**
 * The panel of an operand-row dialog (Curves › Intersect, Project, Offset,
 * Bridge): a {@link FeaturePanel} whose rows of curve or surface picks
 * ({@link OperandSlotControl}) are built from their declarations, with the
 * armed border kept across them and the rows a subclass adds beside them
 * ({@link armable}). One row is armed at a time — the primary border, where
 * viewport and timeline picks land; a click on a row arms it. The dialog
 * opens with the first operand row armed, and a pick in an operand row
 * hands the border to the next one while that one is empty
 * ({@link advanceFrom}). A row beside them is armed only by a click on it,
 * unless it joins the hand-on (`{ handsOn: true }`): then it follows the
 * operand rows in that order — a dialog may have no operand rows at all,
 * and opens on the first such row (Bridge's From, handing on to To).
 *
 * A subclass declares its rows, lays them out in its body HTML (one under
 * another by default) and adds its options — a value typed in a field among
 * them ({@link valueField}: Offset's distance) — and resets them with
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
  /** The rows beside the operand rows that join the hand-on, in the order they were added. */
  private readonly handing = new Map<X, HandingControl>();
  private readonly valueFields: ExpressionField[] = [];
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
      /** The operand rows; none for a dialog of rows beside them alone (Bridge's two ends). */
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

  /** The panel holds value fields ({@link valueField}): the service lists the variables in scope for them as the dialog opens. */
  get hasValueFields(): boolean {
    return this.valueFields.length > 0;
  }

  /** The variables every value field's dropdown offers and its expressions read. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.valueFields) {
      field.setVariables(variables);
    }
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

  /** Create mode: every row empty, the options at their defaults, the first row armed. */
  show(): void {
    this.shell.setTitle(null);
    this.clearRows();
    this.resetOptions();
    this.armRow(this.firstRow());
    this.shell.show();
  }

  /**
   * Edit mode: the service seeds the rows with the statement's own
   * arguments and the options as written; the first row opens armed, a
   * pick there replacing (or adding to) what the statement has.
   */
  showEdit(): void {
    this.shell.setTitle(this.editTitle);
    this.armRow(this.firstRow());
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
   * A pick just landed in `row`: once it holds a pick, the next row of the
   * hand-on — the operand rows, then the rows beside them that joined it —
   * takes the armed border if it is empty, so the next click fills it. A
   * next row that holds something — picks, or an edit's own argument —
   * leaves `row` armed for more, and a row outside the hand-on hands on to
   * nothing.
   */
  advanceFrom(row: R | X): void {
    const chain = this.handOn();
    const at = chain.indexOf(row);
    const next = at < 0 ? undefined : chain[at + 1];
    if (next !== undefined && this.rowHolds(row) && this.rowIsEmpty(next)) {
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

  /**
   * Make the body's `data-role="<role>"` input a value field, a number or
   * an expression ({@link ExpressionField}): Enter applies, typing is a
   * change of the panel's, and its dropdown offers the variables in scope
   * where the statement lands. The subclass reads it into its requests.
   */
  protected valueField(role: string): ExpressionField {
    const field = this.enhance(role);
    this.valueFields.push(field);
    return field;
  }

  /**
   * Add a row beside the operand rows: a click on it arms it, a change in it
   * is the panel's. With `handsOn` it joins the hand-on after the operand
   * rows and the rows that joined before it ({@link advanceFrom}).
   */
  protected armable<C extends ArmableControl>(row: X, control: C): C;
  protected armable<C extends HandingControl>(row: X, control: C, opts: { handsOn: true }): C;
  protected armable<C extends ArmableControl>(row: X, control: C, opts: { handsOn?: boolean } = {}): C {
    control.onArm = () => this.armRow(row);
    control.onChange = () => this.onChange?.();
    this.extras.set(row, control);
    if (opts.handsOn) {
      this.handing.set(row, control as unknown as HandingControl);
    }
    // A dialog of rows beside the operand rows alone has had no row to arm yet.
    this.armed ??= row;
    return control;
  }

  /** The rows a pick hands the border along, in order: the operand rows, then the rows beside them that joined. */
  private handOn(): (R | X)[] {
    return [...this.rows, ...this.handing.keys()];
  }

  /** The row the dialog opens on: the first of the hand-on, else the first row beside the operand rows. */
  private firstRow(): R | X {
    return this.handOn()[0] ?? this.extraRows[0];
  }

  private rowHolds(row: R | X): boolean {
    return this.isOperandRow(row) ? OperandRowPanel.holds(this.slot(row)) : this.handing.get(row)?.holds() === true;
  }

  private rowIsEmpty(row: R | X): boolean {
    return this.isOperandRow(row) ? OperandRowPanel.isEmpty(this.slot(row)) : this.handing.get(row)?.isEmpty() === true;
  }
}
