import { rad } from "../helpers/math-helpers.js";
import { LazyMatrix } from "../math/lazy-matrix.js";
import { type NumberParam, resolveParam } from "../core/param.js";
import type { CopyAxisSource } from "./copy-base.js";
import type { LinearCopyOptions } from "./copy-linear.js";
import type { CircularCopyOptions } from "./copy-circular.js";
import type { RepeatBase } from "./repeat-base.js";

/** One slot a copy lands in: its number, and the move from the original to it. */
export type CopySlot = {
  slot: number;
  matrix: LazyMatrix;
};

/**
 * A copy's slots, numbered the way `repeat().instance(k)` and the 2D
 * `copy().instance(k)` number theirs: a linear grid linearizes its cells with
 * the first axis varying slowest, the original keeping its own cell (0, or the
 * centre cell when `centered`); a circular copy counts rotation steps with the
 * original at 0 — the numbers its `skip` option takes.
 */
export type CopySlotLayout = {
  /** The slot the original holds; the original stays where it is. */
  originalSlot: number;
  /** How many slots the pattern numbers, the original's and skipped ones included. */
  slotCount: number;
  /** Every slot a copy lands in, in slot order: all but the original's and the skipped ones. */
  slots: CopySlot[];
};

/**
 * Where `copy('linear', …)` and `copy('circular', …)` put their copies — the
 * one statement of those rules, read by the copy features' build and by the
 * copy ghost, so what the dialog previews is what the statement builds.
 *
 * The rules are copy()'s own, and a few differ from repeat()'s:
 * - a circular step is the stated offset, or the angle over the count — a
 *   partial arc too, so four copies over 90° step 22.5°, not 30°;
 * - a linear `skip` tuple matches a cell as far as it is stated, so `[1]` in
 *   a two-axis grid names the whole row at index 1;
 * - a count-1 axis spaces nothing, whatever its `length`;
 * - circular `centered` shifts only the copies back by half the pattern, the
 *   original staying put — over a full turn an even count lands one copy on
 *   it, and an odd one packs the copies at half the step.
 *
 * Slot numbers need only the options (counts resolve here), so a layout can be
 * taken at parse time, before any axis object is built. Each slot's move stays
 * a LazyMatrix until something resolves it at build time.
 *
 * The third form, `copy(pattern, …)`, lays out nothing of its own: it takes
 * the slots of the repeat it follows ({@link CopyLayout.follow}).
 */
export class CopyLayout {

  static linear(axes: CopyAxisSource[], options: LinearCopyOptions): CopySlotLayout {
    const { centered, skip } = options;

    const counts = CopyLayout.linearCounts(axes, options);

    const offsets = 'offset' in options && options.offset !== undefined
      ? (Array.isArray(options.offset) ? options.offset : axes.map(() => resolveParam(options.offset as NumberParam)))
      : null;

    const lengths = 'length' in options && options.length !== undefined
      ? (Array.isArray(options.length) ? options.length : axes.map(() => resolveParam(options.length as NumberParam)))
      : null;

    const axisOffsets = axes.map((_, a) => {
      if (offsets) {
        return offsets[a] ?? offsets[0];
      }
      const len = lengths ? (lengths[a] ?? lengths[0]) : 1;
      const axisCount = counts[a];
      return axisCount > 1 ? len / (axisCount - 1) : 0;
    });

    const centerIndices = axes.map((_, a) =>
      centered ? Math.floor(counts[a] / 2) : 0
    );

    // Every cell of the grid, the first axis varying slowest: a cell's place
    // in this list is its slot.
    let cells: number[][] = [[]];
    for (let a = 0; a < axes.length; a++) {
      const next: number[][] = [];
      for (const cell of cells) {
        for (let i = 0; i < counts[a]; i++) {
          next.push([...cell, i]);
        }
      }
      cells = next;
    }

    let originalSlot = 0;
    const slots: CopySlot[] = [];
    cells.forEach((cell, slot) => {
      if (cell.every((index, a) => index === centerIndices[a])) {
        originalSlot = slot;
        return;
      }
      if (skip?.some(tuple => tuple.every((index, a) => index === cell[a]))) {
        return;
      }
      // One translation per axis, applied in axis order.
      const matrix = LazyMatrix.product(axes.map((axis, a) =>
        LazyMatrix.translation(axis, (cell[a] - centerIndices[a]) * axisOffsets[a])
      ));
      slots.push({ slot, matrix });
    });

    return { originalSlot, slotCount: cells.length, slots };
  }

  /**
   * The stated count of each linear axis, as the layout reads it: a list
   * gives one per axis (a missing entry counts no cells), a single count
   * serves every axis.
   */
  static linearCounts(axes: CopyAxisSource[], options: LinearCopyOptions): number[] {
    return Array.isArray(options.count)
      ? options.count
      : axes.map(() => resolveParam(options.count as NumberParam));
  }

  /** The stated count of a circular copy, the original's step included. */
  static circularCount(options: CircularCopyOptions): number {
    return resolveParam(options.count as NumberParam);
  }

  static circular(axis: CopyAxisSource, options: CircularCopyOptions): CopySlotLayout {
    const count = CopyLayout.circularCount(options);
    const { centered, skip } = options;
    const step = CopyLayout.circularStep(count, options);
    const startOffset = centered ? -(count * step) / 2 : 0;

    // Rotation step i is slot i; the original is step 0.
    let slotCount = 1;
    const slots: CopySlot[] = [];
    for (let i = 1; i < count; i++) {
      slotCount = i + 1;
      if (skip?.includes(i)) {
        continue;
      }
      slots.push({ slot: i, matrix: LazyMatrix.rotation(axis, rad(startOffset + step * i)) });
    }

    return { originalSlot: 0, slotCount, slots };
  }

  /**
   * Degrees between neighbouring rotation steps: the stated offset, or the
   * angle divided by the count — always the count, a partial arc included.
   */
  static circularStep(count: number, options: CircularCopyOptions): number {
    if ('offset' in options && options.offset !== undefined) {
      return resolveParam(options.offset as NumberParam);
    }
    return resolveParam((options as { angle: NumberParam }).angle) / count;
  }

  /**
   * The slots of a `repeat()` that `copy(pattern, …)` follows — the repeat's
   * own, none of copy()'s rules: its numbering and original slot, the slots
   * its `skip` left out, and each placed slot's move, the very transform its
   * clones carry (`RepeatBase.getSlotMatrix`). So `bolt.instance(k)` lands
   * where `holes.instance(k)` did, a partial arc spaced the repeat's way. Each
   * move compares by the repeat and the slot (`LazyMatrix.ofSlot`): a linear
   * repeat's moves are opaque, but an unchanged repeat places every slot
   * where it did before.
   */
  static follow(pattern: RepeatBase): CopySlotLayout {
    const numbered = pattern.getInstanceSlots();
    const originalSlot = pattern.getOriginalSlot();
    const slots: CopySlot[] = [];
    numbered.forEach((roots, slot) => {
      if (slot === originalSlot || roots === null) {
        return;
      }
      slots.push({ slot, matrix: LazyMatrix.ofSlot(pattern, slot, pattern.getSlotMatrix(slot)) });
    });
    return { originalSlot, slotCount: numbered.length, slots };
  }
}
