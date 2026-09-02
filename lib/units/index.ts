// fluidcad/units — the unit table, the per-render registry, tolerance helpers
// and the inline conversion helpers user code writes (`extrude(inch(1))`).

export type { LengthUnit } from './units.js';
export {
  LENGTH_UNITS, DEFAULT_LENGTH_UNIT, MM_PER_UNIT, UNIT_DISPLAY_DECIMALS,
  isLengthUnit, parseLengthUnit, convertLength, unitFactor,
} from './units.js';
export { UnitRegistry, createUnitRegistry, getUnitRegistry, setUnitRegistry, getActiveUnit, withUnit } from './registry.js';
export type { UnitRegistryOptions } from './registry.js';
export { mmTol, mmTol2, mmTol3 } from './tolerance.js';

import { captureSourceLocation } from '../index.js';
import { convertLength } from './units.js';
import type { LengthUnit } from './units.js';
import { getUnitRegistry } from './registry.js';

/**
 * Convert `value` (in `from`) into the unit of the CALLING file — the file
 * decides what its numbers mean, so `inch(1)` is 25.4 in an mm document and
 * 1 in an inch document. Meaningful only inside a render of a model file.
 */
function intoCallingFileUnit(helper: string, value: number, from: LengthUnit): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${helper}(): expected a finite number, got ${String(value)}.`);
  }
  const location = captureSourceLocation();
  if (!location) {
    throw new Error(
      `${helper}(): could not determine the calling file — the unit helpers only work inside a .part.js / .assembly.js / .fluid.js model file.`,
    );
  }
  return convertLength(value, from, getUnitRegistry().resolve(location.filePath));
}

export function mm(value: number): number {
  return intoCallingFileUnit('mm', value, 'mm');
}

export function cm(value: number): number {
  return intoCallingFileUnit('cm', value, 'cm');
}

export function m(value: number): number {
  return intoCallingFileUnit('m', value, 'm');
}

/** `in` is a reserved word, hence `inch`. */
export function inch(value: number): number {
  return intoCallingFileUnit('inch', value, 'in');
}

export function ft(value: number): number {
  return intoCallingFileUnit('ft', value, 'ft');
}
