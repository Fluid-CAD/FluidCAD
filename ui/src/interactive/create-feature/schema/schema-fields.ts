import type { FeatureBooleanSpec, FeatureChoiceOption, FeatureNumberSpec, FeatureScalarParam, FeatureTextSpec, FeatureScalarValue, NewVariable, ValueExpr } from '../../../api';
import { OptionButton, RadioGroup, RangeTrack, type ChoiceItem } from '../../../ui/controls';
import { ExpressionField } from '../../../ui/expression-field';
import type { VariableInfo } from '../../../ui/expression-core';
import { FeatureSchema } from './feature-schema';

/** What one typed-in row reads: a value to write, nothing (left out), or why it can't be read. */
export type FieldRead =
  | { value: ValueExpr | boolean | string; newVariable?: NewVariable }
  | { empty: true }
  | { error: string };

/** What a row takes from the dialog it sits in. */
export interface SchemaFieldContext {
  /** Where a file the feature declares (an option's image) is served, as of now. */
  assetUrl(path: string): string;
}

const LABEL_CLASS = 'text-base-content/70';
const INPUT_CLASS = 'input input-sm input-bordered w-full text-xs';

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

  /** The value `visibleWhen` compares: the literal the row holds, or undefined. */
  abstract current(): FeatureScalarValue | undefined;

  /** The value to write. */
  abstract read(): FieldRead;

  /**
   * Show `value` without it counting as the user's: a fresh dialog's
   * default, or an edited statement's own value. Undefined clears the row.
   */
  seed(value: ValueExpr | boolean | string | undefined): void {
    this.changed = false;
    this.show(value);
  }

  protected abstract show(value: ValueExpr | boolean | string | undefined): void;

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
        return new SelectField(name, spec, context);
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

  protected show(value: ValueExpr | boolean | string | undefined): void {
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

/** A yes/no value: the toggle the built-in dialogs use. */
class BooleanField extends SchemaField {
  private readonly input: HTMLInputElement;

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.row.className = 'flex items-center justify-between cursor-pointer';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label;
    this.input = document.createElement('input');
    this.input.dataset.role = `value-${name}`;
    this.input.type = 'checkbox';
    const checkbox = (spec as FeatureBooleanSpec).display === 'checkbox';
    this.input.className = checkbox ? 'checkbox checkbox-sm checkbox-primary' : 'toggle toggle-sm toggle-primary';
    const wrap = document.createElement('label');
    wrap.className = checkbox ? 'flex items-center gap-2 cursor-pointer' : 'contents';
    if (checkbox) {
      // A checkbox leads its label, as checkboxes do.
      this.row.className = 'flex items-center cursor-pointer';
      wrap.append(this.input, label);
    } else {
      wrap.append(label, this.input);
    }
    this.row.append(wrap);
    this.input.addEventListener('change', () => this.touch());
  }

  current(): FeatureScalarValue {
    return this.input.checked;
  }

  read(): FieldRead {
    return { value: this.input.checked };
  }

  protected show(value: ValueExpr | boolean | string | undefined): void {
    this.input.checked = value === true;
  }
}

/** A choice's value: its option's. */
type ChoiceValue = string | number;

/**
 * One of a fixed list — a select or a radio: the declared options carrying
 * their real values (strings or numbers), and the empty choice. A choice
 * without a default — the engine leaves only an optional one without —
 * holds no value until one is chosen, and writes nothing while it holds
 * none. How the options are laid out is the subclass's; what the row holds,
 * reads and shows is the same for both.
 */
abstract class ChoiceField extends SchemaField {
  /** The empty choice's caption. */
  static readonly NONE = '—';

  protected readonly options: readonly FeatureChoiceOption[];
  /** No default: the row may hold nothing. */
  protected readonly unset: boolean;

  constructor(name: string, spec: FeatureScalarParam, protected readonly context: SchemaFieldContext) {
    super(name, spec);
    this.row.className = 'flex flex-col gap-1.5';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label;
    this.row.append(label);
    this.options = spec.type === 'select' || spec.type === 'radio' ? spec.options : [];
    this.unset = spec.default === undefined;
  }

  /** The chosen option's value; undefined while nothing is. */
  protected abstract get chosen(): ChoiceValue | undefined;

  /** Show `value` chosen (undefined: nothing), without it counting as the user's. */
  protected abstract choose(value: ChoiceValue | undefined): void;

  current(): FeatureScalarValue | undefined {
    return this.chosen;
  }

  read(): FieldRead {
    const value = this.chosen;
    return value === undefined ? { empty: true } : { value };
  }

  /** A value no option carries shows as a fresh row does: nothing where the row may hold nothing, else the first option. */
  protected show(value: ValueExpr | boolean | string | undefined): void {
    const option = this.options.find(o => o.value === value);
    this.choose(option ? option.value : this.unset ? undefined : this.options[0]?.value);
  }

  /** The options as a control takes them, each image where it is served now. */
  protected items(): ChoiceItem<ChoiceValue>[] {
    return this.options.map(option => ({
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
}

/**
 * A select. Plain options (`label` and `value` alone) with no `display` or
 * `search` declared are the native `<select>`; anything richer — an image,
 * a description, a group, keywords, a grid, a search box — is a button
 * showing the chosen option that opens a popover of them. Either way a
 * select that may hold nothing offers that as a choice of its own ("—"),
 * first: chosen, the row writes nothing.
 */
class SelectField extends ChoiceField {
  /** Above this many options a select is searched unless it says otherwise. */
  static readonly SEARCH_ABOVE = 12;

  /** What each entry of the control stands for, by its index; the empty choice is undefined. */
  private readonly values: (ChoiceValue | undefined)[];
  private readonly select: HTMLSelectElement | null = null;
  private readonly button: OptionButton<number> | null = null;

  constructor(name: string, spec: FeatureScalarParam, context: SchemaFieldContext) {
    super(name, spec, context);
    this.values = this.unset ? [undefined, ...this.options.map(o => o.value)] : this.options.map(o => o.value);
    if (SelectField.isRich(spec)) {
      const select = spec.type === 'select' ? spec : undefined;
      this.button = new OptionButton<number>({
        items: this.entries(),
        placeholder: ChoiceField.NONE,
        mode: select?.display ?? 'list',
        columns: select?.columns,
        search: select?.search ?? this.options.length > SelectField.SEARCH_ABOVE,
      });
      this.button.element.dataset.role = `value-${name}`;
      this.button.onChange = () => this.touch();
      this.row.append(this.button.element);
      return;
    }
    this.select = document.createElement('select');
    this.select.dataset.role = `value-${name}`;
    this.select.className = 'select select-sm select-bordered w-full text-xs';
    this.values.forEach((value, index) => {
      const el = document.createElement('option');
      el.value = String(index);
      el.textContent = value === undefined ? ChoiceField.NONE : this.options[index - (this.unset ? 1 : 0)].label;
      this.select!.appendChild(el);
    });
    this.row.append(this.select);
    this.select.addEventListener('change', () => this.touch());
  }

  protected get chosen(): ChoiceValue | undefined {
    const index = this.select ? this.select.selectedIndex : this.button?.value;
    return index === undefined ? undefined : this.values[index];
  }

  protected choose(value: ChoiceValue | undefined): void {
    const index = this.values.indexOf(value);
    if (this.select) {
      this.select.selectedIndex = index >= 0 ? index : 0;
    } else {
      // Nothing chosen is the button's placeholder — the empty choice's own caption.
      this.button?.setValue(value === undefined || index < 0 ? undefined : index);
    }
  }

  refreshImages(): void {
    if (this.button && this.hasImages) {
      this.button.setItems(this.entries());
    }
  }

  dismiss(): void {
    this.button?.close();
  }

  destroy(): void {
    this.button?.destroy();
  }

  /** The popover's entries, keyed by their index in {@link values}: the empty choice first where there is one. */
  private entries(): ChoiceItem<number>[] {
    const offset = this.unset ? 1 : 0;
    const items = this.items().map((item, index) => ({ ...item, value: index + offset }));
    return this.unset ? [{ value: 0, label: ChoiceField.NONE }, ...items] : items;
  }

  /** The declaration asks for more than the native select shows. */
  private static isRich(spec: FeatureScalarParam): boolean {
    if (spec.type !== 'select') {
      return false;
    }
    return spec.display !== undefined || spec.search !== undefined || spec.options.some(option =>
      option.image !== undefined || option.description !== undefined || option.group !== undefined || option.keywords !== undefined);
  }
}

/**
 * A radio: every option on show, laid out as its `display` says. One that
 * may hold nothing starts with none chosen and offers a Clear once one is.
 */
class RadioField extends ChoiceField {
  private group: RadioGroup<ChoiceValue>;

  constructor(name: string, spec: FeatureScalarParam, context: SchemaFieldContext) {
    super(name, spec, context);
    this.group = this.build(undefined);
    this.row.append(this.group.element);
  }

  protected get chosen(): ChoiceValue | undefined {
    return this.group.value;
  }

  protected choose(value: ChoiceValue | undefined): void {
    this.group.setValue(value);
  }

  /** The group is drawn once, so new images take a new one — holding what the old one held. */
  refreshImages(): void {
    if (!this.hasImages) {
      return;
    }
    const old = this.group;
    this.group = this.build(old.value);
    old.element.replaceWith(this.group.element);
    old.destroy();
  }

  destroy(): void {
    this.group.destroy();
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
 * Free text, written as a string literal. Without a default an empty row
 * holds no value — a required one asks for text, an optional one writes
 * nothing; with one, emptying the row writes the empty string.
 */
class TextField extends SchemaField {
  private readonly input: HTMLInputElement | HTMLTextAreaElement;
  private readonly look: FeatureTextSpec;
  /** The declared pattern, matched against the whole value; null without one. */
  private readonly pattern: RegExp | null;

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.look = spec as FeatureTextSpec;
    this.pattern = TextField.compile(this.look.pattern);
    this.row.className = 'flex flex-col gap-1.5';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label;
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
    this.row.append(label, this.input);
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
    return this.holdsNothing ? undefined : this.input.value;
  }

  read(): FieldRead {
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

  protected show(value: ValueExpr | boolean | string | undefined): void {
    this.input.value = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  }

  /** The row is empty and the value has no default: there is no text to write. */
  private get holdsNothing(): boolean {
    return this.input.value === '' && this.spec.default === undefined;
  }
}
