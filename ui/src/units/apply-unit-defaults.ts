import { sceneUnit } from './scene-unit';
import { convertLength, roundToUnitDecimals } from './units';
import type { LengthUnit } from './units';

/**
 * Dialog defaults are authored in mm (`value="25"`, `step="0.5"`). Inputs
 * tagged `data-unit="length"` get those rewritten for a non-mm document so
 * an inch file opens Extrude at "1", not "25". Only the *defaults* move —
 * values the user types are read back verbatim by the panels.
 */

/** Values a default is snapped to, per unit; outside the table it just converts. */
const NICE_VALUES: Record<LengthUnit, number[]> = {
  mm: [],
  cm: [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100],
  m: [0.001, 0.002, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10],
  // No 0.2 / 0.375: 5 mm should land on 1/4" and 10 mm on 1/2", not on their
  // decimal neighbours.
  in: [0.01, 0.025, 0.05, 0.1, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 18, 24, 36, 48],
  ft: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 20, 50, 100],
};

const STEP_PER_UNIT: Record<LengthUnit, number> = {
  mm: 0.5,
  cm: 0.1,
  m: 0.001,
  in: 0.0625,
  ft: 0.01,
};

/** A default authored in mm, as the nearest nice number of `unit`. */
export function niceDefault(mm: number, unit: LengthUnit): number {
  if (unit === 'mm' || mm === 0) {
    return mm;
  }
  const converted = convertLength(Math.abs(mm), 'mm', unit);
  const table = NICE_VALUES[unit];
  let best = roundToUnitDecimals(converted, unit);
  if (table.length > 0 && converted >= table[0] && converted <= table[table.length - 1]) {
    best = table[0];
    for (const candidate of table) {
      if (Math.abs(candidate - converted) < Math.abs(best - converted)) {
        best = candidate;
      }
    }
  }
  return mm < 0 ? -best : best;
}

export function unitStep(unit: LengthUnit): number {
  return STEP_PER_UNIT[unit];
}

/**
 * Rewrite `value` / `step` / `min` / `max` of every `data-unit="length"`
 * input under `root` for the current document unit. The mm originals are
 * stashed on the element on first sight, so the pass is idempotent and can
 * re-run when the unit changes.
 */
export function applyUnitDefaults(root: ParentNode, unit: LengthUnit = sceneUnit.current): void {
  const inputs = root.querySelectorAll<HTMLInputElement>('input[data-unit="length"]');
  for (const input of inputs) {
    if (input.dataset.unitApplied === undefined) {
      input.dataset.unitApplied = 'mm';
      input.dataset.mmValue = input.getAttribute('value') ?? '';
      input.dataset.mmStep = input.getAttribute('step') ?? '';
      input.dataset.mmMin = input.getAttribute('min') ?? '';
      input.dataset.mmMax = input.getAttribute('max') ?? '';
    }
    if (input.dataset.unitApplied === unit) {
      continue;
    }
    input.dataset.unitApplied = unit;

    const mmValue = parseFloat(input.dataset.mmValue ?? '');
    if (Number.isFinite(mmValue)) {
      input.value = String(niceDefault(mmValue, unit));
    }
    const mmStep = input.dataset.mmStep ?? '';
    if (mmStep !== '' && Number.isFinite(parseFloat(mmStep))) {
      input.step = unit === 'mm' ? mmStep : String(unitStep(unit));
    }
    for (const attr of ['min', 'max'] as const) {
      const mmBound = parseFloat(input.dataset[attr === 'min' ? 'mmMin' : 'mmMax'] ?? '');
      if (Number.isFinite(mmBound)) {
        input[attr] = String(roundToUnitDecimals(convertLength(mmBound, 'mm', unit), unit));
      }
    }
  }
}

/**
 * Fill `{unit}` in `data-unit-title` templates into `title` — for tooltips
 * that name the unit ("Shift off the path in mm").
 */
export function applyUnitTitles(root: ParentNode, unit: LengthUnit = sceneUnit.current): void {
  const els = root.querySelectorAll<HTMLElement>('[data-unit-title]');
  for (const el of els) {
    el.title = (el.dataset.unitTitle ?? '').replace(/\{unit\}/g, unit);
  }
}
