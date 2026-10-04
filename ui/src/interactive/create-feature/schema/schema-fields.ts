import type { FeatureScalarParam, FeatureScalarValue, NewVariable, ValueExpr } from '../../../api';
import { ExpressionField } from '../../../ui/expression-field';
import type { VariableInfo } from '../../../ui/expression-core';
import { FeatureSchema } from './feature-schema';

/** What one typed-in row reads: a value to write, nothing (left out), or why it can't be read. */
export type FieldRead =
  | { value: ValueExpr | boolean | string; newVariable?: NewVariable }
  | { empty: true }
  | { error: string };

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
  }

  get visible(): boolean {
    return !this.row.classList.contains('hidden');
  }

  /** The variables a number row's dropdown offers. */
  setVariables(_variables: VariableInfo[]): void {}

  destroy(): void {}

  /** The row for a value of this declaration. */
  static create(name: string, spec: FeatureScalarParam): SchemaField {
    switch (spec.type) {
      case 'boolean':
        return new BooleanField(name, spec);
      case 'select':
        return new SelectField(name, spec);
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
 * angles degrees — the metadata's own numbers, shown as they are.
 */
class NumberField extends SchemaField {
  private readonly field: ExpressionField;

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.row.className = 'flex flex-col gap-1.5';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label + NumberField.unitHint(spec);
    const input = document.createElement('input');
    input.dataset.role = `value-${name}`;
    input.type = 'number';
    input.className = INPUT_CLASS;
    this.row.append(label, input);
    // The field flips the input to text, so identifiers and expressions type in.
    this.field = new ExpressionField(input);
    this.field.onSubmit = () => this.onSubmit?.();
    input.addEventListener('input', () => this.touch());
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
  }

  setVariables(variables: VariableInfo[]): void {
    this.field.setVariables(variables);
  }

  destroy(): void {
    this.field.destroy();
  }

  private static unitHint(spec: FeatureScalarParam): string {
    return spec.type === 'angle' ? ' (°)' : '';
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
    this.input.className = 'toggle toggle-sm toggle-primary';
    const wrap = document.createElement('label');
    wrap.className = 'contents';
    wrap.append(label, this.input);
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

/** One of a fixed list: a select whose options carry their real values (strings or numbers). */
class SelectField extends SchemaField {
  private readonly select: HTMLSelectElement;
  private readonly values: (string | number)[];

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.row.className = 'flex flex-col gap-1.5';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label;
    this.select = document.createElement('select');
    this.select.dataset.role = `value-${name}`;
    this.select.className = 'select select-sm select-bordered w-full text-xs';
    const options = spec.type === 'select' ? spec.options : [];
    this.values = options.map(o => o.value);
    options.forEach((option, index) => {
      const el = document.createElement('option');
      el.value = String(index);
      el.textContent = option.label;
      this.select.appendChild(el);
    });
    this.row.append(label, this.select);
    this.select.addEventListener('change', () => this.touch());
  }

  current(): FeatureScalarValue | undefined {
    return this.values[this.select.selectedIndex];
  }

  read(): FieldRead {
    const value = this.current();
    return value === undefined ? { empty: true } : { value };
  }

  protected show(value: ValueExpr | boolean | string | undefined): void {
    const index = this.values.findIndex(v => v === value);
    this.select.selectedIndex = index >= 0 ? index : 0;
  }
}

/** Free text, written as a string literal. */
class TextField extends SchemaField {
  private readonly input: HTMLInputElement;

  constructor(name: string, spec: FeatureScalarParam) {
    super(name, spec);
    this.row.className = 'flex flex-col gap-1.5';
    const label = document.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = spec.label;
    this.input = document.createElement('input');
    this.input.dataset.role = `value-${name}`;
    this.input.type = 'text';
    this.input.className = INPUT_CLASS;
    this.row.append(label, this.input);
    this.input.addEventListener('input', () => this.touch());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onSubmit?.();
      }
    });
  }

  current(): FeatureScalarValue {
    return this.input.value;
  }

  read(): FieldRead {
    return { value: this.input.value };
  }

  protected show(value: ValueExpr | boolean | string | undefined): void {
    this.input.value = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  }
}
