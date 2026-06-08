import { getParamRegistry, type ControlType, type MultiControlType, type SelectOption, type ParamDefinition } from "../param-registry.js";

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

export default function param<T extends string | number | boolean>(label: string, defaultValue: T): T;
export default function param<T extends string | number | boolean, K extends ParamType>(label: string, defaultValue: T, type: K, options?: ParamOptionsMap[K]): T;
export default function param(label: string, defaultValue: (string | number)[], type: 'select', options: SelectParamOptions & { multi: true }): (string | number)[];
export default function param(
  label: string,
  defaultValue: string | number | boolean | (string | number)[],
  type?: ParamType,
  options?: ParamOptionsMap[ParamType],
): string | number | boolean | (string | number)[] {
  const registry = getParamRegistry();
  const value = Array.isArray(defaultValue)
    ? registry.resolve(label, defaultValue)
    : registry.resolve(label, defaultValue);

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

  registry.register(definition);
  return value;
}
