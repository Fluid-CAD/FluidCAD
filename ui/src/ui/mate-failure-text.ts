// Human-readable misclosure for a failing mate — shared by the DOF pill
// and the joints panel so both say the same thing.

import type { MateFailure } from '../solver';
import { formatLength, type LengthUnit } from '../units/units';

/** Gaps under this (document units) are noise next to the tilt term. */
const GAP_MIN = 0.05;
/** Tilts under this many degrees are not worth a word. */
const TILT_MIN_DEG = 0.1;

/**
 * "6.0 mm gap along Y", "0.4° tilt", "6.0 mm gap · 0.4° tilt". Empty when
 * both terms are below their display floor (a mate that fails only on the
 * solver's weighted residual reads as a bare failure).
 */
export function describeMateFailure(f: MateFailure, unit: LengthUnit): string {
  const parts: string[] = [];
  if (f.gap >= GAP_MIN) {
    const along = f.gapAxis ? ` along ${f.gapAxis.toUpperCase()}` : '';
    parts.push(`${formatLength(f.gap, unit, { decimals: 1 })} gap${along}`);
  }
  if (f.tiltDeg >= TILT_MIN_DEG) {
    parts.push(`${f.tiltDeg.toFixed(1)}° tilt`);
  }
  return parts.join(' · ');
}
