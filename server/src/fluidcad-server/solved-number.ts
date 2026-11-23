// How a number the mate solver measured reads in a summary.

/**
 * The solver works in floating point, so a hinge it holds at 30° measures
 * 29.999999999999996 and a gap it closes -0. A joint's value and a failed
 * mate's misclosure are read, never passed back, so the summary reports them
 * to nine decimals — a nanometre in a millimetre document, far below what a
 * solve resolves — with the noise gone and no negative zero. It is also the
 * precision at which two poses count as the same.
 */
export class SolvedNumber {
  private static readonly SCALE = 1e9;

  static round(value: number): number {
    if (!Number.isFinite(value)) {
      return value;
    }
    const rounded = Math.round(value * SolvedNumber.SCALE) / SolvedNumber.SCALE;
    return rounded === 0 ? 0 : rounded;
  }
}
