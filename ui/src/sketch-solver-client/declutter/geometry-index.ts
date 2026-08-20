// Screen-space index of the sketch's own curves, bucketed like Occupancy.
//
// Annotations that land ON the geometry read as noise even when they collide
// with nothing else — a dimension value sitting across the line it measures,
// a badge row crossing three edges. The declutterer scores candidates against
// this index and prefers clear space, which is what turns "no overlaps" into
// "organized".
//
// Soft cost, never a veto: on a dense sketch every candidate crosses
// something, and a shown-but-crossing label still beats a hidden one.

import type { Pt, Rect } from './types';

const CELL_PX = 48;
const CELL_BIAS = 2048;
const CELL_STRIDE = 4096;

type Segment = { a: Pt; b: Pt };

function cellKey(ix: number, iy: number): number {
  return (ix + CELL_BIAS) * CELL_STRIDE + (iy + CELL_BIAS);
}

/** Liang–Barsky slab clip: does the segment touch the axis-aligned box? */
function segmentHitsRect(seg: Segment, rect: Rect): boolean {
  const minX = rect.cx - rect.hw;
  const maxX = rect.cx + rect.hw;
  const minY = rect.cy - rect.hh;
  const maxY = rect.cy + rect.hh;
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) {
      return q >= 0;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) {
        return false;
      }
      if (r > t0) {
        t0 = r;
      }
    } else {
      if (r < t0) {
        return false;
      }
      if (r < t1) {
        t1 = r;
      }
    }
    return true;
  };
  return clip(-dx, seg.a.x - minX)
    && clip(dx, maxX - seg.a.x)
    && clip(-dy, seg.a.y - minY)
    && clip(dy, maxY - seg.a.y);
}

export class GeometryIndex {
  private segments: Segment[] = [];
  private cells = new Map<number, number[]>();

  addPolyline(points: Pt[]): void {
    for (let i = 1; i < points.length; i++) {
      this.addSegment(points[i - 1], points[i]);
    }
  }

  addSegment(a: Pt, b: Pt): void {
    const index = this.segments.length;
    this.segments.push({ a, b });
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL_PX);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL_PX);
    const y0 = Math.floor(Math.min(a.y, b.y) / CELL_PX);
    const y1 = Math.floor(Math.max(a.y, b.y) / CELL_PX);
    // A long diagonal registers in cells its AABB covers but the segment
    // misses; the exact test in `crosses` filters those out.
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = cellKey(ix, iy);
        const bucket = this.cells.get(key);
        if (bucket) {
          bucket.push(index);
        } else {
          this.cells.set(key, [index]);
        }
      }
    }
  }

  /** Does any sketch curve pass through `rect`? */
  crosses(rect: Rect): boolean {
    const x0 = Math.floor((rect.cx - rect.hw) / CELL_PX);
    const x1 = Math.floor((rect.cx + rect.hw) / CELL_PX);
    const y0 = Math.floor((rect.cy - rect.hh) / CELL_PX);
    const y1 = Math.floor((rect.cy + rect.hh) / CELL_PX);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (const index of this.cells.get(cellKey(ix, iy)) ?? []) {
          if (segmentHitsRect(this.segments[index], rect)) {
            return true;
          }
        }
      }
    }
    return false;
  }
}
