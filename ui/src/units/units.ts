/**
 * Length-unit table for the browser UI.
 *
 * Mirrors `lib/units/units.ts` (the kernel's single source of truth) — the
 * UI bundle does not import the `fluidcad` package, so the five supported
 * units and their factors are repeated here verbatim. Keep the two in sync.
 *
 * Core rule (docs/unit-system-plan.md §2): a document's numbers ARE its
 * unit. The scene arrives already in the document unit, so the formatters
 * below only append a suffix and pick per-unit decimals; `convertLength`
 * exists for the one place the user asks for a *different* display unit
 * (the measure panel), and there the base is the document unit, not mm.
 */

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const DEFAULT_LENGTH_UNIT: LengthUnit = 'mm';

export const LENGTH_UNITS: { value: LengthUnit; label: string }[] = [
  { value: 'mm', label: 'Millimeter' },
  { value: 'cm', label: 'Centimeter' },
  { value: 'm', label: 'Meter' },
  { value: 'in', label: 'Inch' },
  { value: 'ft', label: 'Foot' },
];

export const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** Decimals a readout shows per unit — one "mm-ish" of precision each. */
export const UNIT_DISPLAY_DECIMALS: Record<LengthUnit, number> = {
  mm: 2,
  cm: 3,
  m: 4,
  in: 3,
  ft: 4,
};

export function isLengthUnit(value: unknown): value is LengthUnit {
  return value === 'mm' || value === 'cm' || value === 'm' || value === 'in' || value === 'ft';
}

export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  if (from === to) {
    return value;
  }
  return value * (MM_PER_UNIT[from] / MM_PER_UNIT[to]);
}

export type FormatLengthOptions = {
  decimals?: number;
  /** Append the unit symbol (default true). Off for compact canvas labels. */
  suffix?: boolean;
};

/** toFixed that never prints "-0.00". */
function fixed(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** Round to the unit's display decimals — for seeding editable fields. */
export function roundToUnitDecimals(value: number, unit: LengthUnit): number {
  const scale = 10 ** UNIT_DISPLAY_DECIMALS[unit];
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** A length already expressed in `unit`. */
export function formatLength(value: number, unit: LengthUnit, opts: FormatLengthOptions = {}): string {
  const text = fixed(value, opts.decimals ?? UNIT_DISPLAY_DECIMALS[unit]);
  return opts.suffix === false ? text : `${text} ${unit}`;
}

/** An area already expressed in `unit`². */
export function formatArea(value: number, unit: LengthUnit, opts: FormatLengthOptions = {}): string {
  const text = fixed(value, opts.decimals ?? UNIT_DISPLAY_DECIMALS[unit]);
  return opts.suffix === false ? text : `${text} ${unit}²`;
}

/** A volume already expressed in `unit`³. */
export function formatVolume(value: number, unit: LengthUnit, opts: FormatLengthOptions = {}): string {
  const text = fixed(value, opts.decimals ?? UNIT_DISPLAY_DECIMALS[unit]);
  return opts.suffix === false ? text : `${text} ${unit}³`;
}

/** Angles are always degrees — there is no angle display unit. */
export function formatAngle(deg: number): string {
  return `${deg.toFixed(2)} deg`;
}
