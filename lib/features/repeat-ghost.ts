import { rad } from "../helpers/math-helpers.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";

/**
 * One linear direction as the dialog states it, already resolved: an axis to
 * walk along, how many instances to place (the original included) and how far
 * apart. A dialog stating a *total* span divides it out before it gets here —
 * `offset = length / (count - 1)`, the way `repeat()` does (repeat.ts:153).
 */
export type RepeatGhostDirection = {
  axis: Axis;
  count: number;
  offset: number;
};

/**
 * The circular dialog's angle field: the whole sweep to distribute, or the
 * step between neighbours — the two forms `CircularRepeatOptions` accepts.
 */
export type RepeatGhostSweep = { mode: 'angle' | 'offset'; value: number };

/**
 * Where a repeat's instances land, as plain transforms — no scene, no shapes,
 * no `LazyMatrix`. The clone machinery these mirror (`cloneWithTransform`, the
 * `own⁻¹ · clone · own` conjugation a primitive's user transform needs) is
 * build-only; a ghost stamps shapes that are *already built*, so the instance
 * matrix applies to them directly, exactly as `copy()` applies one.
 *
 * The math mirrors `lib/core/repeat.ts` statement for statement, with two
 * deliberate differences:
 *
 * - **The origin instance is never returned.** It is the geometry already on
 *   screen; the ghost draws only what a new statement would add.
 * - **Every precondition is silence, not a throw.** A count of one, a spacing
 *   still at zero, an angle the user hasn't finished typing — the dialog
 *   passes through all of them on the way somewhere, so they yield no
 *   instances rather than an error the panel would flash per keystroke.
 */

/**
 * The grid a linear repeat lays out: the product of the per-direction counts,
 * each cell offset by `direction · offset · index` (repeat.ts:157-208).
 * `centered` shifts every index by half its direction's count, which also
 * moves which cell *is* the original (repeat.ts:172-180).
 */
export function buildLinearGhostMatrices(
  directions: RepeatGhostDirection[],
  centered: boolean,
): Matrix4[] {
  if (directions.length === 0 || !directions.every(isUsableDirection)) {
    return [];
  }

  // Every index combination across the directions — [i], or [i, j] for a grid.
  let cells: number[][] = [[]];
  for (const { count } of directions) {
    const next: number[][] = [];
    for (const cell of cells) {
      for (let i = 0; i < count; i++) {
        next.push([...cell, i]);
      }
    }
    cells = next;
  }

  const matrices: Matrix4[] = [];
  for (const cell of cells) {
    if (isOriginCell(cell, directions, centered)) {
      continue;
    }
    let dx = 0, dy = 0, dz = 0;
    cell.forEach((index, d) => {
      const { axis, count, offset } = directions[d];
      const step = centered ? index - Math.floor(count / 2) : index;
      dx += axis.direction.x * offset * step;
      dy += axis.direction.y * offset * step;
      dz += axis.direction.z * offset * step;
    });
    matrices.push(Matrix4.fromTranslation(dx, dy, dz));
  }
  return matrices;
}

/**
 * The instances a circular repeat spins around its axis. The step comes from
 * whichever form the dialog states: a per-neighbour offset verbatim, or a
 * total sweep divided by `count` when it closes the circle and by `count - 1`
 * when it stops short (repeat.ts:228-233) — the difference between four
 * quarters of a full turn and four instances spanning 90°.
 *
 * `centered` shifts the *clones* back by half the pattern (repeat.ts:235); the
 * original does not move, so the ghost, like the apply, leaves index 0 alone.
 */
export function buildCircularGhostMatrices(
  axis: Axis,
  count: number,
  sweep: RepeatGhostSweep,
  centered: boolean,
): Matrix4[] {
  if (!isUsableCount(count) || !isUsableAxis(axis) || !Number.isFinite(sweep.value)) {
    return [];
  }
  const step = sweep.mode === 'offset'
    ? sweep.value
    : (sweep.value % 360 === 0 ? sweep.value / count : sweep.value / (count - 1));
  if (step === 0 || !Number.isFinite(step)) {
    return [];
  }

  const start = centered ? -(count * step) / 2 : 0;
  const matrices: Matrix4[] = [];
  for (let i = 1; i < count; i++) {
    matrices.push(rotation(axis, start + step * i));
  }
  return matrices;
}

/** The single reflected instance a mirror repeat adds (repeat.ts:265). */
export function buildMirrorGhostMatrices(plane: Plane): Matrix4[] {
  return [Matrix4.mirrorPlane(plane.normal, plane.origin)];
}

/**
 * The single rotated clone `repeat('rotate', …)` adds (repeat.ts:290). An
 * angle that turns nothing — zero, or a whole number of turns — would stamp
 * the instance back onto the original, so it draws nothing instead.
 */
export function buildRotateGhostMatrices(axis: Axis, angle: number): Matrix4[] {
  if (!isUsableAxis(axis) || !Number.isFinite(angle) || angle % 360 === 0) {
    return [];
  }
  return [rotation(axis, angle)];
}

/**
 * How many instances a linear grid describes, the original excluded — read
 * off the counts alone, so the instance cap can be applied *before* any of
 * the grid is materialized. A mistyped count must refuse, not allocate.
 */
export function linearGhostInstanceCount(directions: { count: number }[]): number {
  if (directions.length === 0) {
    return 0;
  }
  const cells = directions.reduce((total, d) => total * Math.max(1, Math.floor(d.count)), 1);
  return Math.max(0, cells - 1);
}

function rotation(axis: Axis, degrees: number): Matrix4 {
  return Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, rad(degrees));
}

/**
 * Whether a cell holds the original rather than a clone. Centered patterns
 * put it at the middle index of every direction, uncentered ones at the
 * origin corner (repeat.ts:172-180).
 */
function isOriginCell(cell: number[], directions: RepeatGhostDirection[], centered: boolean): boolean {
  return centered
    ? cell.every((index, d) => index === Math.floor(directions[d].count / 2))
    : cell.every(index => index === 0);
}

/**
 * A direction the ghost can lay out. A single-instance direction is legal —
 * a 3 × 1 grid is still a pattern — but one that repeats has to say how far
 * apart, and every direction needs a real axis to walk along.
 */
function isUsableDirection(direction: RepeatGhostDirection): boolean {
  if (!Number.isInteger(direction.count) || direction.count < 1 || !isUsableAxis(direction.axis)) {
    return false;
  }
  return direction.count === 1
    || (Number.isFinite(direction.offset) && direction.offset !== 0);
}

function isUsableCount(count: number): boolean {
  return Number.isInteger(count) && count >= 2;
}

/** A zero-length direction spins and translates nothing. */
function isUsableAxis(axis: Axis): boolean {
  return axis.direction.length() > 0;
}
