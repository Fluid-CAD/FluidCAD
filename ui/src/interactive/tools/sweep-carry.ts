// The carried sweep of an arc being drawn around a center: the cursor
// names where the arc ends, and the sweep follows it round.

const TWO_PI = Math.PI * 2;

/**
 * Carry a signed sweep (radians, positive counter-clockwise) to the angle
 * the cursor now names, `target` being that angle measured from the arc's
 * start. The sweep takes the nearest angle congruent to the target rather
 * than the target itself: each sample moves it by less than a half turn,
 * so passing 180 degrees keeps going round to a major arc instead of
 * flipping to the short side. Held within `limit` either way.
 */
export function carrySweep(sweep: number, target: number, limit: number): number {
  let step = (target - sweep) % TWO_PI;
  if (step > Math.PI) {
    step -= TWO_PI;
  } else if (step <= -Math.PI) {
    step += TWO_PI;
  }
  return Math.max(-limit, Math.min(limit, sweep + step));
}
