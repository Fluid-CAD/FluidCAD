// The single source of truth for length units. Pure: no imports from the rest
// of lib, so lib/oc and the UI can both depend on it.

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];

export const DEFAULT_LENGTH_UNIT: LengthUnit = 'mm';

export const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** Decimals a display formatter shows for a value in each unit. */
export const UNIT_DISPLAY_DECIMALS: Record<LengthUnit, number> = {
  mm: 2,
  cm: 3,
  m: 4,
  in: 3,
  ft: 4,
};

const UNIT_ALIASES: Record<string, LengthUnit> = {
  millimeter: 'mm', millimetre: 'mm', millimeters: 'mm', millimetres: 'mm',
  centimeter: 'cm', centimetre: 'cm', centimeters: 'cm', centimetres: 'cm',
  meter: 'm', metre: 'm', meters: 'm', metres: 'm',
  inch: 'in', inches: 'in', '"': 'in',
  foot: 'ft', feet: 'ft', "'": 'ft',
};

export function isLengthUnit(value: unknown): value is LengthUnit {
  return typeof value === 'string' && (LENGTH_UNITS as readonly string[]).includes(value);
}

/** Canonicalise a unit name (case-insensitive, aliases accepted); throws on anything else. */
export function parseLengthUnit(value: unknown): LengthUnit {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (isLengthUnit(lower)) {
      return lower;
    }
    const alias = UNIT_ALIASES[lower] ?? UNIT_ALIASES[trimmed];
    if (alias) {
      return alias;
    }
  }
  throw new Error(`Unknown length unit '${String(value)}'. Use one of: ${LENGTH_UNITS.join(', ')}.`);
}

/** Multiply a length in `from` by this to express it in `to`. */
export function unitFactor(from: LengthUnit, to: LengthUnit): number {
  return MM_PER_UNIT[from] / MM_PER_UNIT[to];
}

export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  if (from === to) {
    return value;
  }
  return value * unitFactor(from, to);
}
