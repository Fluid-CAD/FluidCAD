// Badge-row geometry: how a cluster's boxes sit next to each other.
//
// The row runs ALONG the owning edge (the tangent) rather than stacking out
// perpendicular to it. A perpendicular stack marches away from the geometry
// it annotates — two badges already float 40 px off the curve — while an
// along-edge row stays glued to the edge and reads as one label group, the
// way a text run does.

import type { Pt, Rect } from './types';

/**
 * Extent of an axis-aligned box measured along `dir` (its support radius).
 * Spacing by this — not by width — is what keeps a near-vertical row of wide
 * pills from overlapping itself.
 */
function radiusAlong(dir: Pt, hw: number, hh: number): number {
  return Math.abs(dir.x) * hw + Math.abs(dir.y) * hh;
}

/** Total reach of the row along `dir`, in px — what the cluster's space
 * budget is measured against. */
export function rowLength(dir: Pt, items: { hw: number; hh: number }[], gap: number): number {
  if (items.length === 0) {
    return 0;
  }
  let total = gap * (items.length - 1);
  for (const item of items) {
    total += 2 * radiusAlong(dir, item.hw, item.hh);
  }
  return total;
}

/**
 * Lay `items` contiguously along `dir`, centered on `base`, with `gap` px of
 * clear space between neighbours.
 */
export function rowRects(
  base: Pt,
  dir: Pt,
  items: { hw: number; hh: number }[],
  gap: number,
): Rect[] {
  if (items.length === 0) {
    return [];
  }
  const radii = items.map(item => radiusAlong(dir, item.hw, item.hh));
  const offsets: number[] = [0];
  for (let i = 1; i < items.length; i++) {
    offsets.push(offsets[i - 1] + radii[i - 1] + gap + radii[i]);
  }
  const lo = offsets[0] - radii[0];
  const hi = offsets[offsets.length - 1] + radii[radii.length - 1];
  const shift = -(lo + hi) / 2;
  return items.map((item, i) => {
    const t = offsets[i] + shift;
    return {
      cx: base.x + dir.x * t,
      cy: base.y + dir.y * t,
      hw: item.hw,
      hh: item.hh,
    };
  });
}
