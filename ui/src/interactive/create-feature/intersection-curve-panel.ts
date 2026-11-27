import { iconUrl } from '../../ui/icon-url';
import { FeaturePanel } from './feature-panel';
import { OperandSlotControl } from './operand-slot';

/** The two rows of the dialog: the two sets of faces that meet. */
export type IntersectionRow = 'first' | 'second';

/** What a row asks for while it is armed and holds nothing. */
const ROW_PROMPT = 'Pick surfaces, or faces of a body';

/**
 * The Intersect dialog of the Curves menu — `intersect(first, second)`
 * outside a sketch, the curve where two sets of faces meet. Two surface
 * rows, **First** and **Second**, each taking several picks: a click on a
 * face of a solid takes that face, a click on a surface takes the whole
 * surface (the operand rows' rule, {@link OperandSlotControl}). One row is
 * armed at a time — the primary border, where viewport and timeline picks
 * land; a click on a row arms it. The dialog opens with First armed, and
 * the first pick there hands the border to an empty Second. A curve puts
 * no material anywhere, so there is no operation and no scope. Pure DOM
 * state — the service owns the scene, the previews and the apply call.
 */
export class IntersectionCurvePanel extends FeaturePanel {
  /** Another row took the armed border — the service repaints. */
  onArmedRowChange?: () => void;

  readonly first: OperandSlotControl;
  readonly second: OperandSlotControl;
  private armed: IntersectionRow = 'first';

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-intersection-curve-panel',
      title: 'Intersect',
      icon: iconUrl('intersection-curve'),
      bodyHtml: `
        <div data-role="first-slot"></div>
        <div data-role="second-slot"></div>
      `,
    });
    this.first = this.row('first', 'First');
    this.second = this.row('second', 'Second');
  }

  /** The row picks land in. */
  get armedRow(): IntersectionRow {
    return this.armed;
  }

  /** The control of the row picks land in. */
  get armedSlot(): OperandSlotControl {
    return this.slot(this.armed);
  }

  slot(row: IntersectionRow): OperandSlotControl {
    return row === 'first' ? this.first : this.second;
  }

  /** Create mode: both rows empty, First armed. */
  show(): void {
    this.shell.setTitle(null);
    this.first.reset();
    this.second.reset();
    this.armRow('first');
    this.shell.show();
  }

  /**
   * Edit mode: the service seeds both rows with the statement's own
   * arguments; First opens armed, a pick there replacing (or adding to)
   * what the statement has.
   */
  showEdit(): void {
    this.shell.setTitle('Edit intersect');
    this.armRow('first');
    this.shell.show();
  }

  /** Arm one row: it wears the primary border and takes the next pick. */
  armRow(row: IntersectionRow): void {
    const changed = this.armed !== row;
    this.armed = row;
    this.first.setArmed(row === 'first');
    this.second.setArmed(row === 'second');
    if (changed) {
      this.onArmedRowChange?.();
    }
  }

  /**
   * A pick just landed in `row`: once First holds a pick, an empty Second
   * takes the armed border, so the next click fills it. A Second that holds
   * something — picks, or an edit's own argument — leaves First armed for
   * more.
   */
  advanceFrom(row: IntersectionRow): void {
    if (row === 'first' && IntersectionCurvePanel.holds(this.first) && IntersectionCurvePanel.isEmpty(this.second)) {
      this.armRow('second');
    }
  }

  /** Release the rows: no chips, and no consumed object kept drawn for them. */
  clearRows(): void {
    this.first.reset();
    this.second.reset();
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

  private row(row: IntersectionRow, label: string): OperandSlotControl {
    const control = new OperandSlotControl(this.role(`${row}-slot`), {
      kind: 'surface',
      label,
      prompt: ROW_PROMPT,
      multiple: true,
    });
    control.onArm = () => this.armRow(row);
    control.onChange = () => this.onChange?.();
    return control;
  }
}
