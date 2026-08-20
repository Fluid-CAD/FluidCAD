// Screen-space rect index for the annotation declutterer.
//
// A uniform grid keeps overlap queries local: a candidate row only tests
// against the handful of boxes sharing its cells, so trying every
// (count × side × rung) placement of every cluster stays cheap enough to run
// inside a zoom gesture.
//
// Entries carry an owner id and can be retired: the placement pass reserves
// one head slot per cluster, then revisits each cluster to grow its row —
// which has to ignore (and then replace) that cluster's own reservation.

import type { Rect } from './types';

const CELL_PX = 48;
/** Cell coords are offset into a non-negative range before hashing; the
 * span covers ±98k px of screen, far beyond any viewport. */
const CELL_BIAS = 2048;
const CELL_STRIDE = 4096;

type Entry = { rect: Rect; owner: number; live: boolean };

function cellKey(ix: number, iy: number): number {
  return (ix + CELL_BIAS) * CELL_STRIDE + (iy + CELL_BIAS);
}

function overlaps(a: Rect, b: Rect, pad: number): boolean {
  return Math.abs(a.cx - b.cx) < a.hw + b.hw + pad
    && Math.abs(a.cy - b.cy) < a.hh + b.hh + pad;
}

export class Occupancy {
  private entries: Entry[] = [];
  private cells = new Map<number, number[]>();

  /** Reserve `rect` for `owner` (-1 = an immovable obstacle). */
  add(rect: Rect, owner = -1): void {
    const index = this.entries.length;
    this.entries.push({ rect, owner, live: true });
    this.forEachCell(rect, key => {
      const bucket = this.cells.get(key);
      if (bucket) {
        bucket.push(index);
      } else {
        this.cells.set(key, [index]);
      }
    });
  }

  /** Retire everything `owner` holds — its slots are up for grabs again. */
  release(owner: number): void {
    for (const entry of this.entries) {
      if (entry.owner === owner) {
        entry.live = false;
      }
    }
  }

  /** Does `rect` clear every live reservation except `ignoreOwner`'s? */
  isFree(rect: Rect, ignoreOwner = -2, pad = 0): boolean {
    let free = true;
    this.forEachCell(rect, key => {
      if (!free) {
        return;
      }
      for (const index of this.cells.get(key) ?? []) {
        const entry = this.entries[index];
        if (!entry.live || entry.owner === ignoreOwner) {
          continue;
        }
        if (overlaps(rect, entry.rect, pad)) {
          free = false;
          return;
        }
      }
    });
    return free;
  }

  private forEachCell(rect: Rect, visit: (key: number) => void): void {
    const x0 = Math.floor((rect.cx - rect.hw) / CELL_PX);
    const x1 = Math.floor((rect.cx + rect.hw) / CELL_PX);
    const y0 = Math.floor((rect.cy - rect.hh) / CELL_PX);
    const y1 = Math.floor((rect.cy + rect.hh) / CELL_PX);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        visit(cellKey(ix, iy));
      }
    }
  }
}
