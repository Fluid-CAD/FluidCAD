/**
 * The parameter-editor logic that has nothing to do with the DOM: resolving a
 * definition to the control it actually renders with, seeding the dialog from
 * one, carrying a default value across a type change, and wording the warning
 * a delete needs. The dialog owns the markup; everything decidable without it
 * lives here.
 */

import type { ParamSelectOption, ParamSpec, ParamType, ParamUsage } from '../api';
import type { UIParamDefinition } from '../types';

/** The control types the editor offers, in the order the dropdown lists them. */
export const PARAM_TYPE_CHOICES: { type: ParamType; label: string }[] = [
  { type: 'number', label: 'Number' },
  { type: 'slider', label: 'Slider' },
  { type: 'text', label: 'Text' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'color', label: 'Color' },
  { type: 'select', label: 'Select' },
];

/** How a multi-valued select is presented. */
export const MULTI_CONTROL_CHOICES: { type: NonNullable<ParamSpec['multiControlType']>; label: string }[] = [
  { type: 'select', label: 'List' },
  { type: 'checkboxes', label: 'Checkboxes' },
  { type: 'chips', label: 'Chips' },
];

/** What a colour control falls back to when the old value cannot be one. */
const NEUTRAL_COLOR = '#888888';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * The control a definition renders with. `auto` is what `param()` records when
 * the author named no type, so the editor has to re-derive the same choice the
 * panel draws with — otherwise opening a plain `param('Width', 10)` would show
 * an empty type.
 */
export function effectiveParamType(def: UIParamDefinition): ParamType {
  if (def.controlType !== 'auto') {
    return def.controlType;
  }
  if (typeof def.defaultValue === 'boolean') {
    return 'checkbox';
  }
  return typeof def.defaultValue === 'number' ? 'number' : 'text';
}

/**
 * The dialog's starting state for an existing declaration. Seeded from the
 * *default*, not the current value: the panel's slider edits are runtime
 * overrides, and folding one into the source would silently rewrite the
 * author's declared default.
 */
export function specFromDefinition(def: UIParamDefinition): ParamSpec {
  const spec: ParamSpec = {
    label: def.label,
    defaultValue: def.defaultValue,
    type: effectiveParamType(def),
  };
  if (def.group) {
    spec.group = def.group;
  }
  if (def.description) {
    spec.description = def.description;
  }
  if (def.min != null) {
    spec.min = def.min;
  }
  if (def.max != null) {
    spec.max = def.max;
  }
  if (def.step != null) {
    spec.step = def.step;
  }
  if (def.options) {
    spec.options = def.options.map((o) => ({ ...o }));
  }
  if (def.multi) {
    spec.multi = true;
    spec.multiControlType = def.multiControlType ?? 'select';
  }
  return spec;
}

/**
 * The default value a control keeps when the user switches to it. Values that
 * survive the change do — retyping a slider to a number must not reset it —
 * and anything the new control cannot hold becomes its own neutral value
 * rather than a default that would not render.
 */
export function coerceDefaultValue(
  type: ParamType,
  value: ParamSpec['defaultValue'],
  options: ParamSelectOption[] = [],
  multi = false,
): ParamSpec['defaultValue'] {
  const first = Array.isArray(value) ? value[0] : value;
  switch (type) {
    case 'checkbox':
      return typeof first === 'boolean' ? first : false;
    case 'number':
    case 'slider': {
      if (typeof first === 'number') {
        return first;
      }
      const parsed = Number(first);
      return Number.isFinite(parsed) && String(first).trim() !== '' ? parsed : 0;
    }
    case 'color':
      return typeof first === 'string' && COLOR_RE.test(first) ? first : NEUTRAL_COLOR;
    case 'select': {
      if (options.length === 0) {
        return multi ? [] : '';
      }
      const known = new Set(options.map((o) => String(o.value)));
      const kept = (Array.isArray(value) ? value : [value])
        .filter((v) => known.has(String(v))) as (string | number)[];
      // A multi-valued select keeps every survivor — collapsing to one would
      // silently drop the rest as soon as any option is retyped.
      if (multi) {
        return kept;
      }
      return kept.length > 0 ? kept[0] : options[0].value;
    }
    default:
      return first === undefined || first === null ? '' : String(first);
  }
}

/**
 * What the user is about to break by deleting a parameter. A declaration
 * nothing reads is a clean removal; one the model reads leaves those
 * references undefined, and the next render is where they blow up — so the
 * warning names the variable and where it is read.
 */
export function describeDeletion(label: string, usage: ParamUsage | null): string {
  const base = `Delete “${label}”?`;
  if (!usage || !usage.variable || usage.references === 0) {
    return `${base} Its declaration is removed from the code.`;
  }
  const where = usage.referenceLines.length > 0
    ? ` (line${usage.referenceLines.length === 1 ? '' : 's'} ${usage.referenceLines.join(', ')}${
      usage.references > usage.referenceLines.length ? ', …' : ''})`
    : '';
  const times = usage.references === 1 ? 'once' : `${usage.references} times`;
  return `${base} “${usage.variable}” is still used ${times}${where} — removing the parameter leaves`
    + ' those references undefined and will likely break the model.';
}
