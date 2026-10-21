import { captureSourceLocation, isParamsFile } from "../index.js";
import type { SourceLocation } from "../common/scene-object.js";
import { getCurrentScene } from "../scene-manager.js";
import { Assembly } from "../features/assembly.js";
import {
  activeParamScope, coerceParamOverride, getParamRegistry,
  type ControlType, type MultiControlType, type SelectOption, type ParamDefinition, type ParamKind, type ParamVal,
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
    // A declaration all the same for the first-statement rule of configurations().
    registry.noteBodyParam();
    this._definition = {
      label,
      // The legacy class never refused a top-level call and never stamped
      // `part`; it keeps the inference the registry used to make from that.
      kind: getCurrentScene()?.getActivePart() ? 'part' : 'assembly',
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
    const body = registry.currentBodyId();
    if (body !== null) {
      this._definition.body = body;
      this._definition.bodyName = registry.currentBodyName() ?? body;
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
 * A parameter belongs to a `part(...)` (or `assembly(...)`) body — declare it
 * at the top of the callback, before the geometry that reads it. Called
 * outside every body it is an error — a model file has no parameters of its
 * own — unless the file is a `*.params.js` module: a parameter exported from
 * there is a project parameter, shared with every file that imports it and
 * edited in the Parameters panel, where its value is its declared literal.
 * When the defining file renders, the parameter appears in the Parameters
 * panel under its part, and a value edited there is written back as the new
 * default. Inserted elsewhere, the same declaration is the definition's
 * parameter interface: `insert(def, { Length: 380 })` supplies the value per
 * instance, and the Insert dialog builds that object from these
 * declarations.
 *
 * @param label - The parameter's name — what the panel shows and the key an
 *   override uses. Unique within a part.
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
  // The part whose callback is running owns this declaration: the panel
  // shows a part's parameters under that part, and a declaration lands at
  // the top of the part's body. An assembly body (its own parameter
  // interface) is the next legal home. Outside both, the call is a project
  // parameter when it stands in a `*.params.js` module — and refused where
  // it stands in any other attributed file, rather than registering a stray
  // control (`classifyTopLevelParam`). The location is captured first: it is
  // what the decision reads, and for a global nothing below resolves.
  const declaringPart = getCurrentScene()?.getActivePart() ?? null;
  const sourceLocation = captureSourceLocation();
  const kind: ParamKind = declaringPart ? 'part'
    : Assembly.isBodyRunning() ? 'assembly'
    : classifyTopLevelParam(label, sourceLocation);
  // A definition build in flight (a part variant materializing, an assembly
  // occurrence's body running) resolves against ITS scope only: the insert's
  // override map is the value source, and the declaration is collected as
  // the definition's parameter interface instead of registering globally —
  // the consuming file's params panel never sees an inserted part's
  // internals. No scope → the entry file's own params: global registry,
  // panel overrides, baseline bookkeeping, exactly as before. A project
  // parameter consults neither: its value IS its literal (§2.5 of the
  // global-parameters plan) — no session override, no baseline.
  // In a scope the order is the same as the registry's `resolve`: the
  // insert's override → the configuration row the insert named (installed
  // by the body's `configurations()`) → the literal.
  const registry = getParamRegistry();
  const scope = kind === 'global' ? null : activeParamScope();
  const configuredValue: ParamVal | undefined = kind === 'global'
    ? undefined
    : scope
      ? (scope.configurationValues?.has(label) ? coerceParamOverride(defaultValue, scope.configurationValues.get(label)) : undefined)
      : registry.configuredValue(label, defaultValue);
  const value = kind === 'global'
    ? defaultValue
    : scope
      ? (scope.overrides.has(label) ? coerceParamOverride(defaultValue, scope.overrides.get(label)) : (configuredValue ?? defaultValue))
      : Array.isArray(defaultValue)
        ? registry.resolve(label, defaultValue)
        : registry.resolve(label, defaultValue);
  if (kind !== 'global') {
    // The body's `configurations()` must come before this — the registry
    // remembers so a later statement is refused where it stands.
    registry.noteBodyParam();
  }

  const controlType: ControlType = type
    ?? (typeof defaultValue === 'boolean' ? 'checkbox'
      : typeof defaultValue === 'number' ? 'number'
      : 'text');

  const definition: ParamDefinition = {
    label,
    kind,
    defaultValue,
    currentValue: value,
    controlType,
  };

  if (sourceLocation) {
    definition.sourceLocation = sourceLocation;
  }
  if (configuredValue !== undefined) {
    definition.configuredValue = configuredValue;
  }
  const partLocation = declaringPart?.getSourceLocation();
  if (partLocation) {
    definition.part = partLocation;
  }
  // The body that declared it — with the label, the parameter's identity in
  // the registry: the same label in two parts is two parameters, and so is
  // the same label in two parts of one name (the body is the part's hidden
  // identity; its name rides along for display).
  const body = kind === 'global' ? null : registry.currentBodyId();
  if (body !== null) {
    definition.body = body;
    definition.bodyName = registry.currentBodyName() ?? body;
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

  if (kind === 'global') {
    getParamRegistry().registerGlobal(definition);
  } else if (scope) {
    scope.consumed.add(label);
    scope.collected.set(label, definition);
  } else {
    getParamRegistry().register(definition);
  }
  return value;
}

/**
 * The kind of a `param()` called outside every part and assembly body, from
 * where the call was authored. In a `*.params.js` module it is a project
 * parameter. In any other attributed file it is misplaced and refused.
 * Unattributed (the browser viewer's module evaluator may give V8 no
 * mappable file name; a plain `.js` helper has no script frame) it is a
 * project parameter too: a viewer must render, never throw, over missing
 * attribution — the guard keeps its teeth where frames are always
 * attributed (the desktop's Vite path).
 */
export function classifyTopLevelParam(label: string, location: SourceLocation | null): 'global' {
  if (location && !isParamsFile(location.filePath)) {
    throw new Error(
      `param('${label}') must be declared inside a part() body — move it to the top of the part's callback, `
      + `or export it from a *.params.js file to share it across the project.`,
    );
  }
  return 'global';
}
