// chamfer(): option types, validation and value-argument rendering.

import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * A chamfer statement's second value slot — `chamfer(d1, d2, …)` for two
 * distances, `chamfer(d, angle, true, …)` for distance + angle. Null renders
 * the plain equal-distance form.
 */
export type ChamferEditOptions = {
  distance2: ValueExpr | null;
  /** `distance2` is an angle in degrees — renders the `true` third argument. */
  isAngle: boolean;
};

/**
 * An optional chamfer payload's shape: no payload, an explicit equal-distance
 * form (`distance2: null`), a positive second distance, or an angle in the
 * open (0, 90) — the kernel's chamfer angle range. Expression text passes;
 * the build reports its range errors.
 */
export function validChamferOptions(chamfer: ChamferEditOptions | undefined): boolean {
  if (chamfer === undefined) {
    return true;
  }
  if (typeof chamfer.isAngle !== 'boolean') {
    return false;
  }
  if (chamfer.distance2 === null) {
    return !chamfer.isAngle;
  }
  if (!validValueExpr(chamfer.distance2, { positive: true })) {
    return false;
  }
  return !chamfer.isAngle || typeof chamfer.distance2 !== 'number' || chamfer.distance2 < 90;
}

/**
 * A chamfer statement's value arguments: `d`, `d1, d2`, or `d, angle, true`.
 * Shared by the create transform, the in-place edit, and the route's preview
 * so every rendering of the second-value overloads agrees.
 */
export function renderChamferValueArgs(value: ValueExpr | undefined, chamfer: ChamferEditOptions | undefined): string {
  const distance = formatValue(value);
  if (chamfer?.distance2 === undefined || chamfer.distance2 === null) {
    return distance;
  }
  const second = formatValue(chamfer.distance2);
  return chamfer.isAngle ? `${distance}, ${second}, true` : `${distance}, ${second}`;
}
