import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import {
  buildLinearGhostMatrices, ghostRotation, isUsableGhostAxis, isUsableGhostCount,
  RepeatGhostDirection, RepeatGhostSweep,
} from "./repeat-ghost.js";

/**
 * Where a copy's clones land, as plain transforms — the copy sibling of
 * `lib/features/repeat-ghost.ts`, and the same two deliberate differences from
 * the statement it mirrors: the **original instance is never returned** (it is
 * the geometry already on screen), and every precondition is **silence rather
 * than a throw** (a count still at one, a spacing still at zero — states the
 * dialog passes through while the user types).
 *
 * A copy places its clones the way a repeat does, so most of the math is the
 * repeat's own and is shared rather than restated. Exactly one rule differs,
 * and it is the reason this file exists at all: **a total sweep divides by the
 * instance count, always** (copy-circular.ts:48), where a repeat divides a
 * partial sweep by the gaps between its instances (repeat.ts:230-232). Four
 * copies spanning 90° therefore step 22.5°, not 30°.
 */

/**
 * The grid a linear copy lays out. `copy('linear', …)` walks the same cells
 * `repeat('linear', …)` does — the cartesian product of the per-direction
 * counts, each cell offset by `direction · offset · index`, `centered` shifting
 * every index by half its count (copy-linear.ts:64-98 statement for statement
 * against repeat.ts:157-208) — so the layout is the repeat's, under the copy's
 * name at the call site. `skip` leaves cells out by index tuple, matched as far
 * as each tuple is stated (copy-linear.ts:82), which is the repeat's rule too.
 */
export function buildLinearCopyGhostMatrices(
  directions: RepeatGhostDirection[],
  centered: boolean,
  skip: number[][] = [],
): Matrix4[] {
  return buildLinearGhostMatrices(directions, centered, skip);
}

/**
 * The clones a circular copy spins around its axis. The step is the dialog's
 * Offset value verbatim, or its Total angle divided by the instance count —
 * `copy('circular', axis, {count: 4, angle: 360})` puts a clone every 90°, and
 * the fourth would land back on the original, which is why the original is the
 * one instance no ghost draws.
 *
 * `centered` shifts the clones back by half the pattern (copy-circular.ts:52);
 * the original does not move, so index 0 is left alone as in the apply. The
 * copy dialog offers it for linear patterns only — a hand-written circular
 * statement can still carry it, and the ghost honors what the statement says.
 *
 * `skip` names instances by index, counting the original as 0
 * (copy-circular.ts:55) — the same numbers the dialog's Skip field takes.
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
  const step = sweep.mode === 'offset' ? sweep.value : sweep.value / count;
  if (step === 0 || !Number.isFinite(step)) {
    return [];
  }

  const start = centered ? -(count * step) / 2 : 0;
  const matrices: Matrix4[] = [];
  for (let i = 1; i < count; i++) {
    if (skip.includes(i)) {
      continue;
    }
    matrices.push(ghostRotation(axis, start + step * i));
  }
  return matrices;
}
