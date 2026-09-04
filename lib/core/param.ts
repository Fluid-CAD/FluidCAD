import { captureSourceLocation } from "../index.js";
import {
  activeParamScope, coerceParamOverride, getParamRegistry,
  type ControlType, type MultiControlType, type SelectOption, type ParamDefinition,
} from "../param-registry.js";

export type ParamType = 'number' | 'slider' | 'text' | 'select' | 'checkbox' | 'color';

interface BaseParamOptions {
  group?: string;
  description?: string;
}

export interface NumberParamOptions extends BaseParamOptions {
  min?: number;
  max?: number;
  step?: number;
}

export interface SliderParamOptions extends BaseParamOptions {
  min?: number;
  max?: number;
  step?: number;
}

export interface SelectParamOptions extends BaseParamOptions {
  options: SelectOption[];
  multi?: boolean;
  multiControlType?: MultiControlType;
}

export type CheckboxParamOptions = BaseParamOptions;
export type TextParamOptions = BaseParamOptions;
export type ColorParamOptions = BaseParamOptions;

export interface ParamOptionsMap {
  number: NumberParamOptions;
  slider: SliderParamOptions;
  select: SelectParamOptions;
  checkbox: CheckboxParamOptions;
  text: TextParamOptions;
  color: ColorParamOptions;
}

/** @deprecated Use `param()` with a `ParamOptions` object instead. */
export class ParamValue<T extends string | number | boolean> {

  private _value: T;
  private _definition: ParamDefinition;

  constructor(label: string, defaultValue: T) {
    const registry = getParamRegistry();
    this._value = registry.resolve(label, defaultValue);
    this._definition = {
      label,
      defaultValue,
      currentValue: this._value,
      controlType: typeof defaultValue === 'boolean' ? 'checkbox'
        : typeof defaultValue === 'number' ? 'number'
        : 'text',
    };
    const sourceLocation = captureSourceLocation();
    if (sourceLocation) {
      this._definition.sourceLocation = sourceLocation;
    }
    registry.register(this._definition);
  }

  slider(opts?: { min?: number; max?: number; step?: number }): this {
    this._definition.controlType = 'slider';
    if (opts) {
      if (opts.min != null) { this._definition.min = opts.min; }
      if (opts.max != null) { this._definition.max = opts.max; }
      if (opts.step != null) { this._definition.step = opts.step; }
    }
    return this;
  }

  number(opts?: { min?: number; max?: number; step?: number }): this {
    this._definition.controlType = 'number';
    if (opts) {
      if (opts.min != null) { this._definition.min = opts.min; }
      if (opts.max != null) { this._definition.max = opts.max; }
      if (opts.step != null) { this._definition.step = opts.step; }
    }
    return this;
  }

  text(): this {
    this._definition.controlType = 'text';
    return this;
  }

  checkbox(): this {
    this._definition.controlType = 'checkbox';
    return this;
  }

  select(items: SelectOption[], opts?: { multi?: boolean; multiControlType?: MultiControlType }): this {
    this._definition.controlType = 'select';
    this._definition.options = items;
    if (opts?.multi) {
      this._definition.multi = true;
    }
    if (opts?.multiControlType) {
      this._definition.multiControlType = opts.multiControlType;
    }
    return this;
  }

  description(desc: string): this {
    this._definition.description = desc;
    return this;
  }

  group(name: string): this {
    this._definition.group = name;
    return this;
  }

  valueOf(): T {
    return this._value;
  }

  toString(): string {
    return String(this._value);
  }

  toJSON(): T {
    return this._value;
  }

  [Symbol.toPrimitive](hint: string): T | string {
    if (hint === 'string') {
      return String(this._value);
    }
    return this._value;
  }
}

export type NumberParam = number | ParamValue<number>;
export type StringParam = string | ParamValue<string>;
export type BooleanParam = boolean | ParamValue<boolean>;

export function isNumberParam(v: unknown): v is NumberParam {
  return typeof v === 'number' || (v instanceof ParamValue && typeof v.valueOf() === 'number');
}

export function isBooleanParam(v: unknown): v is BooleanParam {
  return typeof v === 'boolean' || (v instanceof ParamValue && typeof v.valueOf() === 'boolean');
}

export function resolveParam(v: NumberParam): number;
export function resolveParam(v: StringParam): string;
export function resolveParam(v: BooleanParam): boolean;
export function resolveParam(v: NumberParam | StringParam | BooleanParam): number | string | boolean {
  if (v instanceof ParamValue) {
    return v.valueOf();
  }
  return v;
}

/**
 * Declares a named parameter and returns its current value. The control is
 * inferred from the default: a boolean becomes a checkbox, a number a
 * number field, a string a text field.
 *
 * In a part file the parameter appears in the Parameters panel, and a
 * value edited there is written back as the new default. Inside a
 * `part(...)` or `assembly(...)` body it is instead the definition's
 * parameter interface: `insert(def, { Length: 380 })` supplies the value
 * per instance, and the Insert dialog builds that object from these
 * declarations.
 *
 * @param label - The parameter's name — what the panel shows and the key an
 *   override uses. Unique within a file or part.
 * @param defaultValue - The value used when nothing overrides it.
 */
export default function param<T extends string | number | boolean>(label: string, defaultValue: T): T;
/**
 * Declares a named parameter with an explicit control and its options.
 *
 *     const length = param('Length', 150, 'number', { min: 20, max: 2000, step: 10 });
 *     const bore = param('Bore', 4.2, 'slider', { min: 3, max: 8, step: 0.1 });
 *     const finish = param('Finish', 'anodised', 'select', {
 *       options: [{ label: 'Anodised', value: 'anodised' }, { label: 'Raw', value: 'raw' }],
 *     });
 *     const rounded = param('Rounded corners', true, 'checkbox');
 *     const tint = param('Body colour', '#4a90d9', 'color');
 *
 * @param label - The parameter's name and override key.
 * @param defaultValue - The value used when nothing overrides it.
 * @param type - The control: `'number'`, `'slider'`, `'text'`, `'select'`,
 *   `'checkbox'` or `'color'`.
 * @param options - Per-type options: `min` / `max` / `step` for number and
 *   slider, `options` (plus `multi`, `multiControlType`) for select; every
 *   type takes `group` and `description`.
 */
export default function param<T extends string | number | boolean, K extends ParamType>(label: string, defaultValue: T, type: K, options?: ParamOptionsMap[K]): T;
/**
 * Declares a multi-select parameter: the value is the array of chosen option
 * values. `multiControlType` picks how it is shown — `'select'`,
 * `'checkboxes'` or `'chips'`.
 *
 * @param label - The parameter's name and override key.
 * @param defaultValue - The option values selected by default.
 * @param type - Always `'select'`.
 * @param options - `options` to choose from, with `multi: true`.
 */
export default function param(label: string, defaultValue: (string | number)[], type: 'select', options: SelectParamOptions & { multi: true }): (string | number)[];
export default function param(
  label: string,
  defaultValue: string | number | boolean | (string | number)[],
  type?: ParamType,
  options?: ParamOptionsMap[ParamType],
): string | number | boolean | (string | number)[] {
  // A definition build in flight (a part variant materializing, an assembly
  // occurrence's body running) resolves against ITS scope only: the insert's
  // override map is the value source, and the declaration is collected as
  // the definition's parameter interface instead of registering globally —
  // the consuming file's params panel never sees an inserted part's
  // internals. No scope → the entry file's own params: global registry,
  // panel overrides, baseline bookkeeping, exactly as before.
  const scope = activeParamScope();
  const value = scope
    ? (scope.overrides.has(label) ? coerceParamOverride(defaultValue, scope.overrides.get(label)) : defaultValue)
    : Array.isArray(defaultValue)
      ? getParamRegistry().resolve(label, defaultValue)
      : getParamRegistry().resolve(label, defaultValue);

  const controlType: ControlType = type
    ?? (typeof defaultValue === 'boolean' ? 'checkbox'
      : typeof defaultValue === 'number' ? 'number'
      : 'text');

  const definition: ParamDefinition = {
    label,
    defaultValue,
    currentValue: value,
    controlType,
  };

  const sourceLocation = captureSourceLocation();
  if (sourceLocation) {
    definition.sourceLocation = sourceLocation;
  }

  if (options) {
    if ('group' in options && options.group != null) { definition.group = options.group; }
    if ('description' in options && options.description != null) { definition.description = options.description; }
    if ('min' in options && options.min != null) { definition.min = options.min; }
    if ('max' in options && options.max != null) { definition.max = options.max; }
    if ('step' in options && options.step != null) { definition.step = options.step; }
    if ('options' in options && options.options != null) { definition.options = options.options; }
    if ('multi' in options && options.multi != null) { definition.multi = options.multi; }
    if ('multiControlType' in options && options.multiControlType != null) { definition.multiControlType = options.multiControlType; }
  }

  if (scope) {
    scope.consumed.add(label);
    scope.collected.set(label, definition);
  } else {
    getParamRegistry().register(definition);
  }
  return value;
}
