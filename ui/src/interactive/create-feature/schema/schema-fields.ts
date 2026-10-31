import type {
  FeatureBooleanSpec, FeatureChoiceOption, FeatureExprValue, FeatureListValue, FeatureNumberSpec, FeatureRefValue, FeatureScalarParam,
  FeatureTextSpec, FeatureScalarValue, NewVariable, ValueExpr,
} from '../../../api';
import {
  OptionButton, OptionMultiButton, RadioGroup, RangeTrack, type ChoiceItem, type ParameterChoice, type ParameterSource,
} from '../../../ui/controls';
import { ExpressionField } from '../../../ui/expression-field';
import { choiceLiteral, type VariableInfo, type VariableLiteral } from '../../../ui/expression-core';
import { ChoiceParameters } from '../choice-parameters';
import { ExpressionMode, type ExpressionShown } from '../expression-mode';
import { FeatureSchema } from './feature-schema';

/**
 * What a typed-in row holds: a number or an expression, a boolean, a text or
 * an option's value, a list of options' values, a variable named in place
 * of an option (`{ ref }`), or — on any row — a source expression in place
 * of its literal (`{ expr }`).
 */
export type FieldValue = ValueExpr | boolean | string | FeatureListValue | FeatureRefValue | FeatureExprValue;

/**
 * What one typed-in row reads: a value to write (with a declaration to land
 * beside it, and what the ghost draws for it where the value names something
 * the file lacks yet — a choice's new parameter, by the option it declares
 * over), nothing (left out), or why it can't be read.
 */
export type FieldRead =
  | { value: FieldValue; newVariable?: NewVariable; ghost?: FieldValue }
  | { empty: true }
  | { error: string };

/** What a row takes from the dialog it sits in. */
export interface SchemaFieldContext {
  /** Where a file the feature declares (an option's image) is served, as of now. */
  assetUrl(path: string): string;
}

const LABEL_CLASS = 'text-base-content/70';
const INPUT_CLASS = 'input input-sm input-bordered w-full text-xs';
/** A row's label line: the label, and the ƒ toggle at the far end. */
const LABEL_LINE_CLASS = 'flex items-center justify-between gap-2';

/** The label line of a row that takes an expression: its label, and the mode's ƒ toggle at the far end. */
function labelLine(label: string, mode: ExpressionMode): HTMLElement {
  const line = document.createElement('div');
  line.className = LABEL_LINE_CLASS;
  const text = document.createElement('span');
  text.className = LABEL_CLASS;
  text.textContent = label;
  line.append(text, mode.toggle);
  return line;
}

/** A literal as a row's warning says it: an option's or a text's as source, a boolean as it is. */
function literalText(value: VariableLiteral): string {
  return typeof value === 'boolean' ? String(value) : choiceLiteral(value);
}

/**
 * One typed-in row of a custom feature's dialog: its control, its current
 * value (what `visibleWhen` compares), and whether the user changed it —
 * a create writes only the values the user set (a default stays the
 * builder's), an edit only the values the user changed (the rest keep the
 * statement's own text).
 */
export abstract class SchemaField {
  /** A row outside any catalog: a declared file's path stands as it is. */
  private static readonly BARE: SchemaFieldContext = { assetUrl: path => path };

  /** The user changed the value. */
  onChange?: () => void;
  /** Enter in a text-like field. */
  onSubmit?: () => void;

  /** The row element, hidden while its `visibleWhen` fails. */
  readonly row: HTMLElement;
  private changed = false;
  /** What the last seed showed: what the row goes back to when a fixed value lets go of it. */
  private seeded: FieldValue | undefined;
  /** The engine's preview fixed the value from the picks: the row shows it locked, and writes nothing. */
  private fixed = false;
  private fixedNote: HTMLElement | null = null;

  constructor(readonly name: string, protected readonly spec: FeatureScalarParam) {
    this.row = document.createElement('div');
    this.row.dataset.param = name;
    if (spec.description) {
      this.row.title = spec.description;
    }
  }

  /** The user typed, picked or toggled since the last seed. */
  get dirty(): boolean {
    return this.changed;
  }

  /** The row's control fired — the value is the user's now. */
  protected touch(): void {
    this.changed = true;
    this.onChange?.();
  }

  /** The value `visibleWhen` compares: the literal the row holds, or undefined — a list is never compared. */
  abstract current(): FeatureScalarValue | undefined;

  /** The value to write. */
  abstract read(): FieldRead;

  /**
   * Show `value` without it counting as the user's: a fresh dialog's
   * default, or an edited statement's own value. Undefined clears the row.
   */
  seed(value: FieldValue | undefined): void {
    this.seeded = value;
    this.unlock();
    this.changed = false;
    this.show(value);
  }

  /**
   * The engine's preview fixed the value from what was picked (the
   * feature's `derive()`): the row shows `value` locked, with a note, and
   * counts as untouched — the statement never writes it. Undefined lets
   * go: the row shows what it was seeded with again. True when the row's
   * lock or value moved for it.
   */
  setDerived(value: FeatureScalarValue | undefined): boolean {
    if (value === undefined) {
      return this.unlock();
    }
    const moved = !this.fixed || this.current() !== value;
    this.fixed = true;
    this.changed = false;
    this.show(value);
    this.dismiss();
    this.row.toggleAttribute('inert', true);
    this.row.classList.add('opacity-70');
    if (!this.fixedNote) {
      this.fixedNote = document.createElement('div');
      this.fixedNote.dataset.role = 'derived';
      this.fixedNote.className = 'w-full text-[11px] text-base-content/50 italic';
      this.fixedNote.textContent = 'Fixed by what was picked';
      this.row.classList.add('flex-wrap');
      this.row.append(this.fixedNote);
    }
    return moved;
  }

  /** The engine's preview fixed the value from the picks. */
  get isDerived(): boolean {
    return this.fixed;
  }

  /** Let a fixed value go, showing the seed again; true when the row was locked. */
  private unlock(): boolean {
    if (!this.fixed) {
      return false;
    }
    this.fixed = false;
    this.changed = false;
    this.row.toggleAttribute('inert', false);
    this.row.classList.remove('opacity-70');
    this.fixedNote?.remove();
    this.fixedNote = null;
    this.show(this.seeded);
    return true;
  }

  /**
   * Narrows the row to the options the typed-in values offer; true when what
   * it holds moved for it. Only a row of options has any to narrow.
   */
  setOffered(_scalars: Readonly<Record<string, FeatureScalarValue | undefined>>): boolean {
    return false;
  }

  /** Counts the row as changed without announcing it: the panel's pass that moved it announces once. */
  protected moved(): void {
    this.changed = true;
  }

  protected abstract show(value: FieldValue | undefined): void;

  setVisible(visible: boolean): void {
    this.row.classList.toggle('hidden', !visible);
    if (!visible) {
      this.dismiss();
    }
  }

  /** The row is going out of view — hidden, or its dialog closed: close whatever it opened over the page. */
  dismiss(): void {}

  get visible(): boolean {
    return !this.row.classList.contains('hidden');
  }

  /** The variables a number row's dropdown offers. */
  setVariables(_variables: VariableInfo[]): void {}

  /** A file the feature declares was saved: a row showing images asks for them again. Never dirties the row. */
  refreshImages(): void {}

  destroy(): void {}

  /** The row for a value of this declaration. */
  static create(name: string, spec: FeatureScalarParam, context: SchemaFieldContext = SchemaField.BARE): SchemaField {
    const field = SchemaField.build(name, spec, context);
    FeatureSchema.appendHint(field.row, spec.hint);
    return field;
  }

  private static build(name: string, spec: FeatureScalarParam, context: SchemaFieldContext): SchemaField {
    switch (spec.type) {
      case 'boolean':
        return new BooleanField(name, spec);
      case 'select':
        return spec.multiple ? new MultiSelectField(name, spec, context) : new SelectField(name, spec, context);
      case 'radio':
        return new RadioField(name, spec, context);
      case 'text':
        return new TextField(name, spec);
      default:
        return new NumberField(name, spec);
    }
  }
}

/**
 * A number, integer, length or angle: an expression field, so a variable,
 * an expression or a new `name = value` (or `param()`) declaration works as
 * it does in every built-in dialog. Lengths are the document's unit and
 * angles degrees — the metadata's own numbers, shown as they are. Emptied,
 * a row with a default shows that default greyed — what the builder takes
 * for a value left out; one without a default holds nothing.
 */
class NumberField extends SchemaField {
  private static readonly STEP_CLASS = 'btn btn-sm btn-square btn-ghost border border-base-300';

  private readonly field: ExpressionField;
  private readonly look: FeatureNumberSpec;
  private track: RangeTrack | null = null;
  private steppers: HTMLButtonElement[] = [];

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.look = spec as FeatureNumberSpec;
    this.row.className = 'flex flex-col gap-1.5';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label + NumberField.unitHint(this.look);
    const input = document.createElement('input');
    input.dataset.role = `value-${name}`;
    input.type = 'number';
    input.className = INPUT_CLASS;
    if (typeof spec.default === 'number') {
      input.placeholder = String(spec.default);
    }
    this.row.append(label);
    const { min, max, display, suffix } = this.look;
    if (display === 'slider' && min !== undefined && max !== undefined) {
      this.track = new RangeTrack({ min, max, step: NumberField.trackStep(this.look) });
      this.track.element.dataset.role = `track-${name}`;
      this.track.onInput = value => this.write(value);
      this.row.append(this.track.element);
    }
    const line = document.createElement('div');
    line.className = 'flex items-center gap-1';
    const box = document.createElement('div');
    box.className = 'relative flex-1';
    box.append(input);
    if (suffix) {
      const unit = document.createElement('span');
      unit.dataset.role = `suffix-${name}`;
      unit.className = 'absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-base-content/50 pointer-events-none';
      unit.textContent = suffix;
      input.classList.add('pr-10');
      box.append(unit);
    }
    line.append(box);
    if (display === 'stepper') {
      // The number between the buttons stays whole: the box is as wide as the longest the range holds.
      input.classList.add('px-1.5', 'text-center');
      box.style.minWidth = `calc(${NumberField.digits(this.look)}ch + 0.875rem)`;
      this.steppers = [-1, 1].map(direction => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.role = `${direction < 0 ? 'decrement' : 'increment'}-${name}`;
        button.className = NumberField.STEP_CLASS;
        button.textContent = direction < 0 ? '−' : '+';
        button.setAttribute('aria-label', `${direction < 0 ? 'Decrease' : 'Increase'} ${spec.label}`);
        button.addEventListener('click', () => this.stepBy(direction));
        return button;
      });
      line.prepend(this.steppers[0]);
      line.append(this.steppers[1]);
    }
    this.row.append(line);
    // The field flips the input to text, so identifiers and expressions type in.
    this.field = new ExpressionField(input);
    this.field.onSubmit = () => this.onSubmit?.();
    input.addEventListener('input', () => {
      this.follow();
      this.touch();
    });
    this.follow();
  }

  /** The number the input holds: undefined for an expression or a variable; null while it is empty. */
  private get plain(): number | null | undefined {
    const read = this.field.read();
    if ('error' in read) {
      return read.error === 'empty' ? null : undefined;
    }
    return typeof read.value === 'number' ? read.value : undefined;
  }

  /** The track and the buttons follow the input: a number places the thumb, an expression greys both. */
  private follow(): void {
    const plain = this.plain;
    this.track?.setValue(typeof plain === 'number' ? plain : undefined);
    for (const button of this.steppers) {
      button.disabled = plain === undefined;
    }
  }

  /** A number from the track or the buttons: into the input, as the user's. */
  private write(value: number): void {
    this.field.setValue(Number(value.toPrecision(12)));
    this.follow();
    this.touch();
  }

  /** One step up or down from the number shown (an empty row starts at its default, else its min, else 0), kept inside the range. */
  private stepBy(direction: number): void {
    const plain = this.plain;
    if (plain === undefined) {
      return;
    }
    const { min, max, step, default: fallback } = this.look;
    const next = (plain ?? fallback ?? min ?? 0) + direction * (step ?? 1);
    this.write(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
  }

  /** The characters the widest number of the range takes — 3 at least, so a typed variable shows its start. */
  private static digits(spec: FeatureNumberSpec): number {
    const widths = [spec.min, spec.max, spec.default].filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      .map(n => String(n).length);
    return Math.min(8, Math.max(3, ...widths));
  }

  /** The track's step: the declared one, 1 for an integer, else a hundredth of the range to one figure. */
  private static trackStep(spec: FeatureNumberSpec): number {
    if (spec.step !== undefined) {
      return spec.step;
    }
    const span = (spec.max ?? 0) - (spec.min ?? 0);
    return spec.type === 'integer' || !(span > 0) ? 1 : Number((span / 100).toPrecision(1));
  }

  current(): FeatureScalarValue | undefined {
    const read = this.field.read();
    return 'error' in read ? undefined : read.value;
  }

  read(): FieldRead {
    const read = this.field.read();
    if ('error' in read) {
      return read.error === 'empty' ? { empty: true } : { error: `${this.spec.label}: ${read.error}` };
    }
    if (typeof read.value === 'number') {
      const error = FeatureSchema.numberError(this.spec, read.value);
      if (error) {
        return { error };
      }
    }
    return read.newVariable ? { value: read.value, newVariable: read.newVariable } : { value: read.value };
  }

  protected show(value: FieldValue | undefined): void {
    this.field.setValue(typeof value === 'number' || typeof value === 'string' ? value : '');
    this.follow();
  }

  setVariables(variables: VariableInfo[]): void {
    this.field.setVariables(variables);
  }

  destroy(): void {
    this.field.destroy();
  }

  /** An angle says its unit in the label, unless a `suffix` says it in the input. */
  private static unitHint(spec: FeatureNumberSpec): string {
    return spec.type === 'angle' && !spec.suffix ? ' (°)' : '';
  }
}

/**
 * A yes/no value: the toggle the built-in dialogs use — or, in expression
 * mode, an expression that evaluates to one (`count > 4`, `!left`), shown
 * with the `true` or `false` it comes to.
 */
class BooleanField extends SchemaField {
  private readonly input: HTMLInputElement;
  private readonly mode: ExpressionMode;

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.row.className = 'flex items-center justify-between flex-wrap gap-y-1.5 cursor-pointer';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label;
    this.input = document.createElement('input');
    this.input.dataset.role = `value-${name}`;
    this.input.type = 'checkbox';
    this.mode = new ExpressionMode({
      name,
      label: spec.label,
      seed: () => String(this.input.checked),
      describe: value => typeof value === 'boolean'
        ? { text: String(value) }
        : { text: literalText(value), warning: `${this.mode.text} is ${literalText(value)}, which is not true or false.` },
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.touch();
    this.mode.onSubmit = () => this.onSubmit?.();
    const checkbox = (spec as FeatureBooleanSpec).display === 'checkbox';
    this.input.className = checkbox ? 'checkbox checkbox-sm checkbox-primary' : 'toggle toggle-sm toggle-primary';
    const wrap = document.createElement('label');
    wrap.className = checkbox ? 'flex items-center gap-2 cursor-pointer' : 'contents';
    if (checkbox) {
      // A checkbox leads its label, as checkboxes do; the ƒ toggle sits at the far end.
      this.row.className = 'flex items-center flex-wrap gap-y-1.5 cursor-pointer';
      wrap.append(this.input, label);
      this.row.append(wrap, this.mode.toggle);
    } else {
      wrap.append(label, this.input);
      // The ƒ toggle between the label and the switch: the switch keeps the end of the line.
      const end = document.createElement('span');
      end.className = 'flex items-center gap-2';
      end.append(this.mode.toggle, this.input);
      this.row.append(label, end);
    }
    this.row.append(this.mode.line);
    this.input.addEventListener('change', () => this.touch());
  }

  current(): FeatureScalarValue | undefined {
    if (this.mode.on) {
      const value = this.mode.value();
      return typeof value === 'boolean' ? value : undefined;
    }
    return this.input.checked;
  }

  read(): FieldRead {
    return this.mode.on ? this.mode.read() : { value: this.input.checked };
  }

  /** The switch gives way to the expression, and takes its place again on what the expression comes to, when it comes to true or false. */
  private toggleMode(on: boolean): void {
    if (!on) {
      const resolved = this.mode.value();
      if (typeof resolved === 'boolean') {
        this.input.checked = resolved;
      }
    }
    this.input.classList.toggle('hidden', on);
  }

  protected show(value: FieldValue | undefined): void {
    if (ExpressionMode.isExpr(value)) {
      this.mode.show(value.expr);
      this.input.classList.add('hidden');
      this.input.checked = this.mode.value() === true;
      return;
    }
    this.mode.clear();
    this.input.classList.remove('hidden');
    this.input.checked = value === true;
  }

  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
  }

  destroy(): void {
    this.mode.destroy();
  }
}

/** A choice's value: its option's. */
type ChoiceValue = string | number;

/**
 * A row over a fixed list of options — a select, of one or of several, or a
 * radio: its label above the control, and the declared options as a control
 * takes them. A select may name a variable in place of an option (`{ ref }`):
 * the row then holds the name, shows what it selects, and writes it bare; the
 * machinery for that lives here, and a radio takes none of it.
 */
abstract class OptionsField extends SchemaField {
  protected readonly options: readonly FeatureChoiceOption[];
  /** The options the row lists now: all of them until `setOffered` narrows. */
  protected offered: readonly FeatureChoiceOption[];
  /** The variable the row names in place of an option, or null while it holds an option (or nothing). */
  protected ref: string | null = null;
  /** The parameter the row declared itself over the option it showed: written with the statement. */
  protected declared: NewVariable | null = null;
  /** The parameters the row offers and resolves; null for a row that takes none. */
  protected readonly parameters: ChoiceParameters | null;
  /** The row's expression mode: an expression in place of an option, or of the list. */
  protected readonly mode: ExpressionMode;
  private open: readonly FeatureChoiceOption[];
  private kept: ChoiceValue[] = [];
  private fresh = false;
  private none: HTMLElement | null = null;

  constructor(name: string, spec: FeatureScalarParam, protected readonly context: SchemaFieldContext, parameters: 'none' | 'one' | 'list') {
    super(name, spec);
    this.row.className = 'flex flex-col gap-1.5';
    this.mode = new ExpressionMode({
      name,
      label: spec.label,
      seed: () => this.sourceOfHeld(),
      describe: value => this.describe(value),
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.touch();
    this.mode.onSubmit = () => this.onSubmit?.();
    this.row.append(labelLine(spec.label, this.mode));
    this.options = spec.type === 'select' || spec.type === 'radio' ? spec.options : [];
    this.offered = this.open = this.options;
    this.parameters = parameters === 'none' ? null : new ChoiceParameters(spec.label, () => this.options, parameters === 'list');
  }

  /** What the row holds as source, for an expression to start from: a named variable, an option, a list; empty for nothing. */
  protected abstract sourceOfHeld(): string;

  /** The user switched the mode: the control gives way to the expression, or takes its place again. */
  protected toggleMode(on: boolean): void {
    if (on) {
      this.placeExpression();
    }
    this.control.classList.toggle('hidden', on);
  }

  /** The expression's line takes the control's place in the row — put there the first time it is needed, after the control the subclass added. */
  private placeExpression(): void {
    if (this.mode.line.parentElement !== this.row) {
      this.control.after(this.mode.line);
    }
  }

  /** The literals the row takes: an option's value, or (a select of several) a list of them. */
  protected abstract get holdsList(): boolean;

  /**
   * How the row shows the literal its expression resolves to: the labels of
   * the options it selects, muted — or the value under a warning when it is
   * none of them, as a bound variable's shows.
   */
  protected describe(value: VariableLiteral): ExpressionShown {
    const mismatch = { text: literalText(value), warning: `${this.mode.text} is ${literalText(value)}, which is not one of the options.` };
    if (typeof value === 'boolean' || this.holdsList !== Array.isArray(value)) {
      return mismatch;
    }
    const values = Array.isArray(value) ? value : [value];
    const labels = values.map(each => this.options.find(option => option.value === each)?.label);
    if (labels.some(label => label === undefined)) {
      return mismatch;
    }
    return { text: labels.length === 0 ? 'None' : labels.join(', ') };
  }

  /** The option values the expression resolves to, when it resolves to ones the row offers; null otherwise. */
  protected expressionValues(): ChoiceValue[] | null {
    const value = this.mode.value();
    if (value === undefined || typeof value === 'boolean' || this.holdsList !== Array.isArray(value)) {
      return null;
    }
    const values = Array.isArray(value) ? value : [value];
    return values.every(each => this.options.some(option => option.value === each)) ? values : null;
  }

  /** The row shows a statement's expression — the control put away, the option (or list) it resolves to held underneath. */
  protected showExpression(expr: string): void {
    this.unbind();
    this.placeExpression();
    this.mode.show(expr);
    this.control.classList.add('hidden');
  }

  /** The row holds an option (or a variable) again: the expression goes. */
  protected leaveExpression(): void {
    this.mode.clear();
    this.control.classList.remove('hidden');
  }

  destroy(): void {
    this.mode.destroy();
  }

  /** The muted line that stands in for the choices; made the first time there are none, so a row that always has some is unchanged. */
  private note(): HTMLElement {
    if (!this.none) {
      this.none = document.createElement('span');
      this.none.className = 'text-xs text-base-content/50';
      this.none.dataset.role = 'no-options';
      this.none.textContent = 'No options';
      this.row.append(this.none);
    }
    return this.none;
  }

  /** What the row holds, as a list: a single choice is a list of one or none; a named variable, the options it selects. */
  protected abstract held(): ChoiceValue[];

  /** Shows `offered` in the control, holding on to what of `before` it still carries. */
  protected abstract offer(before: ChoiceValue[]): void;

  /** The element that shows the choices, which "No options" stands in for. */
  protected abstract get control(): HTMLElement;

  /** Seeding starts from every option: the pass that follows narrows them around what was seeded. */
  seed(value: FieldValue | undefined): void {
    this.fresh = true;
    this.kept = [];
    this.open = this.options;
    this.present(this.options, []);
    super.seed(value);
  }

  /**
   * The options whose `when` holds, in declared order. What a seed put in the
   * row stays listed though its `when` fails — a statement may hold any
   * declared option, and the row shows what the statement says — until the
   * other values change what is offered. A choice that then falls away moves
   * to the first one offered (a list drops it) and the row counts as changed.
   */
  setOffered(scalars: Readonly<Record<string, FeatureScalarValue | undefined>>): boolean {
    if (!this.options.some(option => option.when !== undefined)) {
      return false;
    }
    const open = this.options.filter(option => FeatureSchema.holds(option.when, scalars));
    if (this.fresh) {
      this.kept = this.held().filter(value => !open.some(option => option.value === value));
    } else if (!OptionsField.same(open, this.open)) {
      this.kept = [];
    }
    this.fresh = false;
    this.open = open;
    const before = this.held();
    if (!this.present(this.options.filter(option => open.includes(option) || this.kept.includes(option.value)), before)) {
      return false;
    }
    const after = this.held();
    if (before.length === after.length && before.every((value, index) => value === after[index])) {
      return false;
    }
    this.moved();
    return true;
  }

  /** Puts `offered` in the row; false when it is what the row shows already. */
  private present(offered: readonly FeatureChoiceOption[], before: ChoiceValue[]): boolean {
    if (OptionsField.same(offered, this.offered)) {
      return false;
    }
    this.offered = offered;
    this.offer(before);
    if (offered.length === 0 || this.none) {
      this.note().hidden = offered.length > 0;
    }
    this.control.hidden = offered.length === 0;
    return true;
  }

  /** What `read()` answers while no option is offered, and nothing otherwise. */
  protected get nothingOffered(): FieldRead | undefined {
    if (this.offered.length > 0) {
      return undefined;
    }
    return this.spec.optional ? { empty: true } : { error: `${this.spec.label} has no option to choose.` };
  }

  private static same(a: readonly FeatureChoiceOption[], b: readonly FeatureChoiceOption[]): boolean {
    return a.length === b.length && a.every((option, index) => option === b[index]);
  }

  /** The options as a control takes them, each image where it is served now. */
  protected items(): ChoiceItem<ChoiceValue>[] {
    return this.offered.map(option => ({
      value: option.value,
      label: option.label,
      image: option.image === undefined ? undefined : this.context.assetUrl(option.image),
      description: option.description,
      group: option.group,
      keywords: option.keywords,
    }));
  }

  protected get hasImages(): boolean {
    return this.options.some(option => option.image !== undefined);
  }

  // --- A variable in place of an option -------------------------------------

  /** The option values the named variable selects, when known; none otherwise. */
  protected resolvedValues(): ChoiceValue[] {
    if (this.ref === null || !this.parameters) {
      return [];
    }
    const resolution = this.parameters.resolve(this.ref);
    return resolution.kind === 'options' ? resolution.values : [];
  }

  /** Show the row bound to `ref` — the name, and what it selects. Never called on a row without parameters. */
  protected showBinding(): void {}

  /** What a parameter declared now would hold: the option (or list) the row shows; undefined when it shows nothing. */
  protected seedForNew(): ChoiceValue | ChoiceValue[] | undefined {
    return undefined;
  }

  /** The popover's Parameters group, for a row that offers them. */
  protected parameterSource(): ParameterSource | undefined {
    const parameters = this.parameters;
    return parameters ? (query, matched) => parameters.suggest(query, matched, this.seedForNew(), this.ref) : undefined;
  }

  /** The variable named in place of an option (a seed, a parse), shown bound; not the user's. */
  protected bind(ref: string): void {
    this.ref = ref;
    this.declared = null;
    this.parameters?.forget();
    this.showBinding();
  }

  /** The row holds an option (or nothing) again: the name and any declaration go. */
  protected unbind(): void {
    this.ref = null;
    this.declared = null;
    this.parameters?.forget();
  }

  /** The user chose a parameter row: an existing variable, or the offer to declare one over what the row showed when it was offered. */
  protected takeParameter(choice: ParameterChoice): void {
    if (!this.parameters) {
      return;
    }
    if (choice.isNew) {
      const declared = this.parameters.declare(choice.name);
      if (!declared) {
        return;
      }
      this.declared = declared;
    } else {
      this.declared = null;
      this.parameters.forget();
    }
    this.ref = choice.name;
    this.showBinding();
    this.touch();
  }

  /** The user chose an option: the row is its own again. */
  protected takeOption(): void {
    this.unbind();
    this.touch();
  }

  /**
   * The bound value to write — the name, with the declaration of a parameter
   * declared here and the option it was declared over for the ghost to draw
   * — or why it can't be written: a value no option carries.
   */
  protected readBinding(): FieldRead {
    const ref = this.ref!;
    const error = this.parameters?.error(ref) ?? null;
    if (error) {
      return { error };
    }
    const value: FeatureRefValue = { ref };
    const over = this.parameters?.declaredValue;
    return this.declared && over !== undefined ? { value, newVariable: this.declared, ghost: over } : { value };
  }

  /** The variables the popover offers and an expression resolves over; a bound row shows what its name selects by them. */
  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
    if (!this.parameters) {
      return;
    }
    this.parameters.variables = variables;
    if (this.ref !== null) {
      this.showBinding();
    }
  }
}

/**
 * One of a fixed list — a select or a radio: the declared options carrying
 * their real values (strings or numbers), and the empty choice. A choice
 * without a default — the engine leaves only an optional one without —
 * holds no value until one is chosen, and writes nothing while it holds
 * none. How the options are laid out is the subclass's; what the row holds,
 * reads and shows is the same for both.
 */
abstract class ChoiceField extends OptionsField {
  /** The empty choice's caption. */
  static readonly NONE = '—';

  /** No default: the row may hold nothing. */
  protected readonly unset: boolean;

  constructor(name: string, spec: FeatureScalarParam, context: SchemaFieldContext, parameters: 'none' | 'one') {
    super(name, spec, context, parameters);
    this.unset = spec.default === undefined;
  }

  /** The chosen option's value; undefined while nothing is, or a variable stands in its place. */
  protected abstract get chosen(): ChoiceValue | undefined;

  /** Show `value` chosen (undefined: nothing), without it counting as the user's. */
  protected abstract choose(value: ChoiceValue | undefined): void;

  /** The option the row stands on: the chosen one, the one a named variable selects, or the one its expression comes to. */
  current(): FeatureScalarValue | undefined {
    if (this.mode.on) {
      return this.expressionValues()?.[0];
    }
    return this.ref !== null ? this.resolvedValues()[0] : this.chosen;
  }

  read(): FieldRead {
    if (this.mode.on) {
      return this.mode.read();
    }
    const nothing = this.nothingOffered;
    if (nothing) {
      return nothing;
    }
    if (this.ref !== null) {
      return this.readBinding();
    }
    const value = this.chosen;
    return value === undefined ? { empty: true } : { value };
  }

  protected held(): ChoiceValue[] {
    const value = this.current();
    return value === undefined ? [] : [value as ChoiceValue];
  }

  protected get holdsList(): boolean {
    return false;
  }

  protected sourceOfHeld(): string {
    if (this.ref !== null) {
      return this.ref;
    }
    const value = this.chosen;
    return value === undefined ? '' : choiceLiteral(value);
  }

  /**
   * Switching to an expression lets a named variable go — the name is the
   * expression's start — and back lands on the option the expression comes
   * to, when it comes to one; else on the option the row stood on.
   */
  protected toggleMode(on: boolean): void {
    if (on && this.ref !== null) {
      const before = this.current() as ChoiceValue | undefined;
      this.unbind();
      this.choose(before ?? (this.unset ? undefined : this.offered[0]?.value));
    }
    if (!on) {
      const resolved = this.expressionValues();
      if (resolved !== null) {
        this.choose(resolved[0]);
      }
    }
    super.toggleMode(on);
  }

  /** A named variable stays named, and an expression stays, through a narrowing: what either selects is the file's to say. */
  protected offer(before: ChoiceValue[]): void {
    this.relist();
    if (this.mode.on) {
      return;
    }
    if (this.ref !== null) {
      this.showBinding();
      return;
    }
    const stays = this.offered.some(option => option.value === before[0]);
    this.choose(stays ? before[0] : this.unset ? undefined : this.offered[0]?.value);
  }

  /** Rebuilds the control's choices from `offered`. */
  protected abstract relist(): void;

  protected seedForNew(): ChoiceValue | undefined {
    return this.current() as ChoiceValue | undefined;
  }

  /**
   * A value no option carries shows as a fresh row does: nothing where the row
   * may hold nothing, else the first option. A variable named in place of an
   * option shows bound on a row that takes parameters — and as a value no
   * option carries on one that doesn't (a radio). An expression shows in
   * expression mode, on every row, the control underneath on the option it
   * comes to (or the fresh row's) for the way back.
   */
  protected show(value: FieldValue | undefined): void {
    if (ExpressionMode.isExpr(value)) {
      this.showExpression(value.expr);
      this.choose(this.expressionValues()?.[0] ?? (this.unset ? undefined : this.options[0]?.value));
      return;
    }
    this.leaveExpression();
    if (ChoiceParameters.isRef(value)) {
      if (this.parameters) {
        this.bind(value.ref);
        return;
      }
      value = undefined;
    }
    this.unbind();
    const option = this.options.find(o => o.value === value);
    this.choose(option ? option.value : this.unset ? undefined : this.options[0]?.value);
  }
}

/**
 * A select: a button showing the chosen option that opens a popover of them
 * — rows, or a grid of images — with a search box, whose text filters the
 * options and the parameters in scope alike: a parameter picked from the
 * list stands in for the option, the button showing its name with the option
 * it selects muted beside it; a fresh name typed there declares one. A select
 * that may hold nothing offers that as a choice of its own ("—"), first:
 * chosen, the row writes nothing.
 */
class SelectField extends ChoiceField {
  /** What each entry of the control stands for, by its index; the empty choice is undefined. */
  private values: (ChoiceValue | undefined)[] = [];
  private readonly button: OptionButton<number>;

  constructor(name: string, spec: FeatureScalarParam, context: SchemaFieldContext) {
    super(name, spec, context, 'one');
    this.index();
    const select = spec.type === 'select' ? spec : undefined;
    this.button = new OptionButton<number>({
      items: this.entries(),
      placeholder: ChoiceField.NONE,
      mode: select?.display ?? 'list',
      columns: select?.columns,
      // The search box is where a parameter's name is typed: on unless the declaration turns it off.
      search: select?.search ?? true,
      parameters: this.parameterSource(),
    });
    this.button.element.dataset.role = `value-${name}`;
    this.button.onChange = () => this.takeOption();
    this.button.onBind = choice => this.takeParameter(choice);
    this.row.append(this.button.element);
  }

  protected get control(): HTMLElement {
    return this.button.element;
  }

  private index(): void {
    const values = this.offered.map(o => o.value);
    this.values = this.unset ? [undefined, ...values] : values;
  }

  protected relist(): void {
    this.index();
    this.button.setItems(this.entries());
  }

  protected get chosen(): ChoiceValue | undefined {
    const index = this.button.value;
    return index === undefined ? undefined : this.values[index];
  }

  protected choose(value: ChoiceValue | undefined): void {
    const index = this.values.indexOf(value);
    // Nothing chosen is the button's placeholder — the empty choice's own caption.
    this.button.setValue(value === undefined || index < 0 ? undefined : index);
  }

  protected showBinding(): void {
    this.button.setBinding(this.parameters!.binding(this.ref!));
  }

  refreshImages(): void {
    if (this.hasImages) {
      this.button.setItems(this.entries());
    }
  }

  dismiss(): void {
    this.button.close();
  }

  destroy(): void {
    this.button.destroy();
    super.destroy();
  }

  /** The popover's entries, keyed by their index in {@link values}: the empty choice first where there is one. */
  private entries(): ChoiceItem<number>[] {
    const offset = this.unset ? 1 : 0;
    const items = this.items().map((item, index) => ({ ...item, value: index + offset }));
    return this.unset ? [{ value: 0, label: ChoiceField.NONE }, ...items] : items;
  }
}

/**
 * A select of several (`multiple`): the button and its popover, whose
 * options toggle while it stays open. The row holds a list of the chosen
 * options' values, in the options' own order however they were chosen, and
 * always reads as one: with none chosen it is the empty list, never a value
 * left out — or a variable holding a list, named in place of it. `min` and
 * `max` bound how many it may hold. A list takes no part in `visibleWhen`.
 */
class MultiSelectField extends OptionsField {
  private readonly button: OptionMultiButton<ChoiceValue>;
  private readonly min: number | undefined;
  private readonly max: number | undefined;

  constructor(name: string, spec: FeatureScalarParam, context: SchemaFieldContext) {
    super(name, spec, context, 'list');
    const select = spec.type === 'select' ? spec : undefined;
    this.min = select?.min;
    this.max = select?.max;
    this.button = new OptionMultiButton<ChoiceValue>({
      items: this.items(),
      mode: select?.display ?? 'list',
      columns: select?.columns,
      search: select?.search ?? true,
      parameters: this.parameterSource(),
    });
    this.button.element.dataset.role = `value-${name}`;
    this.button.onChange = () => this.takeOption();
    this.button.onBind = choice => this.takeParameter(choice);
    this.row.append(this.button.element);
  }

  current(): undefined {
    return undefined;
  }

  protected get control(): HTMLElement {
    return this.button.element;
  }

  /** The list the row holds: its own, the one the named variable holds when known, or the one its expression comes to. */
  protected held(): ChoiceValue[] {
    if (this.mode.on) {
      return this.expressionValues() ?? [];
    }
    return this.ref !== null ? this.resolvedValues() : this.button.value;
  }

  protected get holdsList(): boolean {
    return true;
  }

  protected sourceOfHeld(): string {
    return this.ref ?? choiceLiteral(this.button.value);
  }

  /**
   * Switching to an expression lets a named variable go — the name is the
   * expression's start — and back lands on the list the expression comes
   * to, when it comes to one; else on the list the row stood on.
   */
  protected toggleMode(on: boolean): void {
    if (on && this.ref !== null) {
      const before = this.resolvedValues();
      this.unbind();
      this.button.setValue(before);
    }
    if (!on) {
      const resolved = this.expressionValues();
      if (resolved !== null) {
        this.button.setValue(resolved);
      }
    }
    super.toggleMode(on);
  }

  /** The button keeps the values its items still carry, and lets go of the rest; a named variable stays named, an expression stays. */
  protected offer(): void {
    this.button.setItems(this.items());
    if (this.ref !== null && !this.mode.on) {
      this.showBinding();
    }
  }

  protected seedForNew(): ChoiceValue[] | undefined {
    return this.held();
  }

  protected showBinding(): void {
    this.button.setBinding(this.parameters!.binding(this.ref!), this.resolvedValues());
  }

  read(): FieldRead {
    if (this.mode.on) {
      return this.mode.read();
    }
    const nothing = this.nothingOffered;
    if (nothing) {
      return nothing;
    }
    if (this.ref !== null) {
      const bound = this.readBinding();
      // A list the variable is known to hold keeps to the bounds; one it may hold is the file's to check.
      const resolved = this.resolvedValues();
      return 'value' in bound && resolved.length > 0 ? this.bounded(resolved) ?? bound : bound;
    }
    const value = this.button.value;
    return this.bounded(value) ?? { value };
  }

  /** Why `value` breaks the row's bounds, or null when it keeps to them. */
  private bounded(value: ChoiceValue[]): FieldRead | null {
    if (this.min !== undefined && value.length < this.min) {
      return { error: `${this.spec.label} takes at least ${this.min}.` };
    }
    if (this.max !== undefined && value.length > this.max) {
      return { error: `${this.spec.label} takes at most ${this.max}.` };
    }
    return null;
  }

  /** The options a list names, chosen; a variable named in its place, bound; an expression, in expression mode over the list it comes to; anything else — no list, a value no option carries — chooses nothing. */
  protected show(value: FieldValue | undefined): void {
    if (ExpressionMode.isExpr(value)) {
      this.showExpression(value.expr);
      this.button.setValue(this.expressionValues() ?? []);
      return;
    }
    this.leaveExpression();
    if (ChoiceParameters.isRef(value)) {
      this.bind(value.ref);
      return;
    }
    this.unbind();
    this.button.setValue(Array.isArray(value) ? value : []);
  }

  refreshImages(): void {
    if (this.hasImages) {
      this.button.setItems(this.items());
    }
  }

  dismiss(): void {
    this.button.close();
  }

  destroy(): void {
    this.button.destroy();
    super.destroy();
  }
}

/**
 * A radio: every option on show, laid out as its `display` says. One that
 * may hold nothing starts with none chosen and offers a Clear once one is.
 * A radio names no variable: an author who wants a bindable value declares
 * a select, and a statement naming one on a radio shows as a fresh row —
 * though a radio takes an expression like every row, a bare name among them.
 */
class RadioField extends ChoiceField {
  private readonly group: RadioGroup<ChoiceValue>;

  constructor(name: string, spec: FeatureScalarParam, context: SchemaFieldContext) {
    super(name, spec, context, 'none');
    this.group = this.build(undefined);
    this.row.append(this.group.element);
  }

  protected get control(): HTMLElement {
    return this.group.element;
  }

  protected relist(): void {
    this.group.setItems(this.items());
  }

  protected get chosen(): ChoiceValue | undefined {
    return this.group.value;
  }

  protected choose(value: ChoiceValue | undefined): void {
    this.group.setValue(value);
  }

  /** The group is drawn once, so new images take a new one — holding what the old one held. */
  refreshImages(): void {
    if (this.hasImages) {
      this.group.setItems(this.items());
    }
  }

  destroy(): void {
    this.group.destroy();
    super.destroy();
  }

  private build(value: ChoiceValue | undefined): RadioGroup<ChoiceValue> {
    const radio = this.spec.type === 'radio' ? this.spec : undefined;
    const group = new RadioGroup<ChoiceValue>({
      items: this.items(),
      value,
      display: radio?.display ?? 'list',
      columns: radio?.columns,
      allowClear: this.unset,
      label: this.spec.label,
    });
    group.element.dataset.role = `value-${this.name}`;
    group.onChange = () => this.touch();
    return group;
  }
}

/**
 * Free text, written as a string literal — or, in expression mode, an
 * expression that evaluates to one (a template string, a name), shown with
 * the text it comes to. Without a default an empty row holds no value — a
 * required one asks for text, an optional one writes nothing; with one,
 * emptying the row writes the empty string.
 */
class TextField extends SchemaField {
  private readonly input: HTMLInputElement | HTMLTextAreaElement;
  private readonly look: FeatureTextSpec;
  /** The declared pattern, matched against the whole value; null without one. */
  private readonly pattern: RegExp | null;
  /** An expression in place of the text: a template string, a name, a concatenation. */
  private readonly mode: ExpressionMode;

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.look = spec as FeatureTextSpec;
    this.pattern = TextField.compile(this.look.pattern);
    this.row.className = 'flex flex-col gap-1.5';
    this.mode = new ExpressionMode({
      name,
      label: spec.label,
      seed: () => choiceLiteral(this.input.value),
      describe: value => typeof value === 'string'
        ? { text: choiceLiteral(value) }
        : { text: literalText(value), warning: `${this.mode.text} is ${literalText(value)}, which is not text.` },
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.touch();
    this.mode.onSubmit = () => this.onSubmit?.();
    const label = labelLine(spec.label, this.mode);
    const multiline = this.look.multiline === true;
    if (multiline) {
      this.input = document.createElement('textarea');
      this.input.rows = 3;
      this.input.className = 'textarea textarea-sm textarea-bordered w-full text-xs';
    } else {
      this.input = document.createElement('input');
      this.input.type = 'text';
      this.input.className = INPUT_CLASS;
    }
    this.input.dataset.role = `value-${name}`;
    if (this.look.placeholder) {
      this.input.placeholder = this.look.placeholder;
    }
    this.row.append(label, this.input, this.mode.line);
    this.input.addEventListener('input', () => this.touch());
    this.input.addEventListener('keydown', (e: Event) => {
      const key = e as KeyboardEvent;
      // Several lines: Enter is a new line, and Ctrl/Cmd+Enter applies.
      if (key.key === 'Enter' && (!multiline || key.ctrlKey || key.metaKey)) {
        key.preventDefault();
        this.onSubmit?.();
      }
    });
  }

  private static compile(pattern: string | undefined): RegExp | null {
    if (!pattern) {
      return null;
    }
    try {
      return new RegExp(`^(?:${pattern})$`, 'u');
    } catch {
      return null;
    }
  }

  current(): FeatureScalarValue | undefined {
    if (this.mode.on) {
      const value = this.mode.value();
      return typeof value === 'string' ? value : undefined;
    }
    return this.holdsNothing ? undefined : this.input.value;
  }

  read(): FieldRead {
    if (this.mode.on) {
      return this.mode.read();
    }
    if (this.holdsNothing) {
      return { empty: true };
    }
    const value = this.input.value;
    if (this.look.maxLength !== undefined && value.length > this.look.maxLength) {
      return { error: `${this.spec.label} is at most ${this.look.maxLength} characters.` };
    }
    if (this.pattern && !this.pattern.test(value)) {
      return { error: `${this.spec.label} must match ${this.look.pattern}.` };
    }
    return { value };
  }

  /** The input gives way to the expression, and takes its place again on the text the expression comes to, when it comes to one. */
  private toggleMode(on: boolean): void {
    if (!on) {
      const resolved = this.mode.value();
      if (typeof resolved === 'string') {
        this.input.value = resolved;
      }
    }
    this.input.classList.toggle('hidden', on);
  }

  protected show(value: FieldValue | undefined): void {
    if (ExpressionMode.isExpr(value)) {
      this.mode.show(value.expr);
      this.input.classList.add('hidden');
      const resolved = this.mode.value();
      this.input.value = typeof resolved === 'string' ? resolved : '';
      return;
    }
    this.mode.clear();
    this.input.classList.remove('hidden');
    this.input.value = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  }

  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
  }

  destroy(): void {
    this.mode.destroy();
  }

  /** The row is empty and the value has no default: there is no text to write. */
  private get holdsNothing(): boolean {
    return this.input.value === '' && this.spec.default === undefined;
  }
}
