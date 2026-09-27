import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { CopyLayout } from "./copy-layout.js";
import type { CircularCopyOptions } from "./copy-circular.js";
import {
  isUsableGhostAxis, isUsableGhostCount, isUsableGhostDirection,
  RepeatGhostDirection, RepeatGhostSweep,
} from "./repeat-ghost.js";

/**
 * Where a copy's clones land, as plain transforms — the copy sibling of
 * `lib/features/repeat-ghost.ts`, with the same two deliberate differences
 * from the statement it mirrors: the **original instance is never returned**
 * (it is the geometry already on screen), and every precondition is **silence
 * rather than a throw** (a count still at one, a spacing still at zero —
 * states the dialog passes through while the user types).
 *
 * The slots themselves are the statement's: both builders hand the dialog's
 * values to `CopyLayout`, the layout `copy()` builds with, and keep only the
 * silence. That is how a copy's rules reach the preview where they differ from
 * a repeat's — most visibly the circular step, a total sweep divided by the
 * instance count always, so four copies spanning 90° step 22.5°, not 30°.
 */

/**
 * The grid a linear copy lays out: the cartesian product of the per-direction
 * counts, each cell offset by `direction · offset · index`, `centered` shifting
 * every index by half its count. `skip` leaves cells out by index tuple,
 * matched as far as each tuple is stated.
 */
export function buildLinearCopyGhostMatrices(
  directions: RepeatGhostDirection[],
  centered: boolean,
  skip: number[][] = [],
): Matrix4[] {
  if (directions.length === 0 || !directions.every(isUsableGhostDirection)) {
    return [];
  }
  const layout = CopyLayout.linear(directions.map(direction => direction.axis), {
    count: directions.map(direction => direction.count),
    offset: directions.map(direction => direction.offset),
    centered,
    skip,
  });
  return layout.slots.map(slot => slot.matrix.resolve());
}

/**
 * The clones a circular copy spins around its axis. The step is the dialog's
 * Offset value verbatim, or its Total angle divided by the instance count —
 * `copy('circular', axis, {count: 4, angle: 360})` puts a clone every 90°, and
 * the fourth would land back on the original, which is why the original is the
 * one instance no ghost draws.
 *
 * `centered` shifts the clones back by half the pattern; the original does not
 * move, so index 0 is left alone as in the apply. The copy dialog offers it for
 * linear patterns only — a hand-written circular statement can still carry it,
 * and the ghost honors what the statement says.
 *
 * `skip` names instances by index, counting the original as 0 — the same
 * numbers the dialog's Skip field takes.
 */
export function buildCircularCopyGhostMatrices(
  axis: Axis,
  count: number,
  sweep: RepeatGhostSweep,
  centered: boolean,
  skip: number[] = [],
): Matrix4[] {
  if (!isUsableGhostCount(count) || !isUsableGhostAxis(axis) || !Number.isFinite(sweep.value)) {
    return [];
  }
  const options: CircularCopyOptions = sweep.mode === 'offset'
    ? { count, offset: sweep.value, centered, skip }
    : { count, angle: sweep.value, centered, skip };
  const step = CopyLayout.circularStep(count, options);
  if (step === 0 || !Number.isFinite(step)) {
    return [];
  }
  return CopyLayout.circular(axis, options).slots.map(slot => slot.matrix.resolve());
}
