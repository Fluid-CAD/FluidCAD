import { Box3, Vector3 } from 'three';

/** The gap left beside a placed part, as a share of that part's largest side. */
const GAP_RATIO = 0.1;

/**
 * Where the Insert dialog puts new instances: in a row along +X, each one
 * just clear of everything before it — what the assembly already shows, then
 * the earlier parts of the same basket. Without this every insert lands at
 * the origin, on top of the parts already there.
 *
 * The rules:
 * - An empty assembly takes its first part at the origin, untouched.
 * - Every later part moves along X only, so the written call stays
 *   `.translate(x, 0, 0)`: its low X side sits one gap past the high X side
 *   of everything placed so far. Being past it in X, it overlaps nothing
 *   whatever its Y and Z.
 * - The gap is a tenth of the part's largest side (of what is placed so far,
 *   for a part whose size is unknown), and the distance is rounded up to a
 *   round number of that magnitude, so the code reads `120`, not `118.37`.
 * - A part's bounds are its catalog picture's: the default values, in the
 *   assembly's unit. Changed values can make it larger than measured; the
 *   row keeps its order and the user drags from there.
 */
export class InsertPlacement {
  private readonly occupied = new Box3();

  /** `occupied` is what the assembly shows now, in world space; null or empty for none. */
  constructor(occupied: Box3 | null) {
    if (occupied && !occupied.isEmpty()) {
      this.occupied.copy(occupied);
    }
  }

  /**
   * The position for the next part, whose geometry spans `bounds` around its
   * own origin (null when it couldn't be measured); null to leave it at the
   * origin. The spot is taken from then on.
   */
  next(bounds: Box3 | null): [number, number, number] | null {
    const own = bounds && !bounds.isEmpty() ? bounds : new Box3(new Vector3(), new Vector3());
    if (this.occupied.isEmpty()) {
      this.occupied.copy(own);
      return null;
    }
    const size = InsertPlacement.largestSide(bounds && !bounds.isEmpty() ? own : this.occupied);
    const gap = size * GAP_RATIO;
    const x = InsertPlacement.roundUp(this.occupied.max.x + gap - own.min.x, gap);
    this.occupied.union(own.clone().translate(new Vector3(x, 0, 0)));
    return [x, 0, 0];
  }

  private static largestSide(box: Box3): number {
    const size = box.getSize(new Vector3());
    return Math.max(size.x, size.y, size.z);
  }

  /** `value` rounded up to a multiple of the power of ten at or under `gap` (7.5 → whole units, 0.3 → tenths). */
  private static roundUp(value: number, gap: number): number {
    if (!(gap > 0)) {
      return value;
    }
    const step = 10 ** Math.floor(Math.log10(gap));
    return Math.ceil(value / step - 1e-9) * step;
  }
}
