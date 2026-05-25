import { getParamRegistry, type SelectOption, type ParamDefinition } from "../param-registry.js";

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

  select(items: SelectOption[], opts?: { multi?: boolean }): this {
    this._definition.controlType = 'select';
    this._definition.selectOptions = items;
    if (opts?.multi) {
      this._definition.multi = true;
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

export default function param<T extends string | number | boolean>(label: string, defaultValue: T): ParamValue<T> {
  return new ParamValue(label, defaultValue);
}
