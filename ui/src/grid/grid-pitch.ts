import { viewerSettings } from '../scene/viewer-settings';
import type { UserPreferences } from '../api';
import { isLengthUnit } from '../units/units';
import type { LengthUnit } from '../units/units';

/** How the scale-bar chip persists what it changes (`EngineClient.savePreference`). */
export type PreferenceSaver = <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => void;

/**
 * Read a grid pitch the way a machinist types one: a decimal ("0.125",
 * "2.5"), a simple fraction ("1/8", "3/16"), or a mixed number ("1 1/2").
 * A trailing unit word is tolerated and ignored (the field is in document
 * units, and the label it replaces shows one). Null for anything else, and
 * for zero or negative — a grid cannot have those pitches.
 */
export function parseGridPitch(text: string): number | null {
  let s = text.trim().toLowerCase();
  const unitSuffix = s.match(/\s*([a-z"']+)$/);
  if (unitSuffix && (isLengthUnit(unitSuffix[1]) || unitSuffix[1] === '"' || unitSuffix[1] === "'")) {
    s = s.slice(0, s.length - unitSuffix[0].length).trim();
  }
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  const fraction = s.match(/^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/);
  let value: number;
  if (mixed) {
    const whole = Number(mixed[1]);
    const den = Number(mixed[3]);
    value = den === 0 ? NaN : whole + Number(mixed[2]) / den;
  } else if (fraction) {
    const den = Number(fraction[2]);
    value = den === 0 ? NaN : Number(fraction[1]) / den;
  } else if (/^\d*\.?\d+$/.test(s)) {
    value = Number(s);
  } else {
    return null;
  }
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Pin the grid to `pitch` for `unit`: the fixed spacing for that unit is
 * set and the lock engages (adaptive off), both in the live store — which
 * re-pitches the drawn grid at once — and in the preferences file. The
 * other units keep their pitches; the server merges the record per key.
 */
export function lockGridPitch(unit: LengthUnit, pitch: number, save: PreferenceSaver): void {
  const gridFixedSpacing = { ...viewerSettings.current.gridFixedSpacing, [unit]: pitch };
  viewerSettings.update({ gridFixedSpacing, gridAdaptive: false });
  save('gridFixedSpacing', gridFixedSpacing);
  save('gridAdaptive', false);
}

/** Lock (fixed pitch) or unlock (adaptive to zoom) the grid, persisted. */
export function setGridLocked(locked: boolean, save: PreferenceSaver): void {
  viewerSettings.update({ gridAdaptive: !locked });
  save('gridAdaptive', !locked);
}
