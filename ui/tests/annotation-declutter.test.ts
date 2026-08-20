import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DECLUTTER_OPTIONS,
  GeometryIndex,
  Occupancy,
  clusterAnchors,
  declutterAnnotations,
  rowRects,
} from '../src/sketch-solver-client/declutter';
import type { BadgeItem, DimensionItem, Pt } from '../src/sketch-solver-client/declutter';

// ---------------------------------------------------------------------------
// The declutterer is pure screen-space math (px, y down), so everything here
// is plain numbers: no camera, no Three, no DOM.
// ---------------------------------------------------------------------------

const RIGHT: Pt = { x: 1, y: 0 };
const DOWN: Pt = { x: 0, y: 1 };

/** A 16 px badge on a 200 px horizontal edge at `at`. */
function badge(at: Pt, order: number, overrides: Partial<BadgeItem> = {}): BadgeItem {
  return {
    anchor: at,
    groupKey: `${at.x},${at.y}`,
    out: DOWN,
    along: RIGHT,
    spanPx: 200,
    hw: 8,
    hh: 8,
    rank: 5,
    order,
    ...overrides,
  };
}

function dimension(at: Pt, order: number, overrides: Partial<DimensionItem> = {}): DimensionItem {
  return {
    anchor: at,
    slide: RIGHT,
    push: DOWN,
    style: 'span',
    slideRangePx: 60,
    hw: 16,
    hh: 8,
    order,
    ...overrides,
  };
}

function run(badges: BadgeItem[], dimensions: DimensionItem[] = [], geometry = new GeometryIndex()) {
  return declutterAnnotations({
    badges,
    dimensions,
    obstacles: [],
    geometry,
    // Match the real pill: a boxed "+N", one char wider per extra digit.
    pillSize: count => ({ hw: 8 + 3 * String(count).length, hh: 8 }),
  });
}

function boxes(items: { anchor: Pt; hw: number; hh: number }[], placements: { visible: boolean; dx: number; dy: number }[]) {
  return placements
    .map((p, i) => ({ p, item: items[i] }))
    .filter(({ p }) => p.visible)
    .map(({ p, item }) => ({
      cx: item.anchor.x + p.dx,
      cy: item.anchor.y + p.dy,
      hw: item.hw,
      hh: item.hh,
    }));
}

function anyOverlap(rects: { cx: number; cy: number; hw: number; hh: number }[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (Math.abs(a.cx - b.cx) < a.hw + b.hw && Math.abs(a.cy - b.cy) < a.hh + b.hh) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------

describe('occupancy index', () => {
  it('reports overlap only for boxes that actually intersect', () => {
    const occ = new Occupancy();
    occ.add({ cx: 100, cy: 100, hw: 10, hh: 10 });
    expect(occ.isFree({ cx: 100, cy: 100, hw: 10, hh: 10 })).toBe(false);
    expect(occ.isFree({ cx: 121, cy: 100, hw: 10, hh: 10 })).toBe(true);
    // ... including across grid-cell boundaries.
    expect(occ.isFree({ cx: 115, cy: 100, hw: 10, hh: 10 })).toBe(false);
  });

  it('ignores the querying owner and honours released slots', () => {
    const occ = new Occupancy();
    occ.add({ cx: 0, cy: 0, hw: 10, hh: 10 }, 7);
    expect(occ.isFree({ cx: 0, cy: 0, hw: 10, hh: 10 })).toBe(false);
    expect(occ.isFree({ cx: 0, cy: 0, hw: 10, hh: 10 }, 7)).toBe(true);
    occ.release(7);
    expect(occ.isFree({ cx: 0, cy: 0, hw: 10, hh: 10 })).toBe(true);
  });
});

describe('geometry index', () => {
  it('finds a diagonal only where it truly passes through a box', () => {
    const geometry = new GeometryIndex();
    geometry.addSegment({ x: 0, y: 0 }, { x: 200, y: 200 });
    expect(geometry.crosses({ cx: 100, cy: 100, hw: 6, hh: 6 })).toBe(true);
    // Same AABB cells as the segment, but nowhere near the line itself.
    expect(geometry.crosses({ cx: 180, cy: 20, hw: 6, hh: 6 })).toBe(false);
  });
});

describe('row layout', () => {
  it('centers a row on its base and never overlaps along a vertical axis', () => {
    const items = [{ hw: 20, hh: 8 }, { hw: 20, hh: 8 }, { hw: 20, hh: 8 }];
    const vertical = rowRects({ x: 0, y: 0 }, DOWN, items, 4);
    expect(vertical[1].cy).toBeCloseTo(0, 9);
    // Spacing must use the extent ALONG the row (height here), not width.
    expect(vertical[1].cy - vertical[0].cy).toBeCloseTo(20, 9);
    expect(anyOverlap(vertical.map(r => ({ ...r })))).toBe(false);
  });
});

describe('anchor clustering', () => {
  it('merges anchors within the radius and keeps a bounded diameter', () => {
    const groups = [0, 20, 40, 60, 80].map(x => ({
      anchor: { x, y: 0 },
      items: [{ order: x }],
    }));
    // Single-linkage would chain all five (each gap is 20 < 26); leader
    // clustering caps a cluster at 2·radius across.
    const clusters = clusterAnchors(groups, item => item.order, 26);
    expect(clusters.length).toBeGreaterThan(1);
    for (const cluster of clusters) {
      const xs = cluster.items.map(i => i.order);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(52);
    }
  });

  it('is order-stable: the same input always clusters the same way', () => {
    const groups = [10, 15, 90].map(x => ({ anchor: { x, y: 0 }, items: [{ order: x }] }));
    const a = clusterAnchors(groups, i => i.order, 26).map(c => c.items.map(i => i.order));
    const b = clusterAnchors(groups, i => i.order, 26).map(c => c.items.map(i => i.order));
    expect(a).toEqual(b);
  });
});

describe('badge rows', () => {
  it('rows badges sharing an anchor ALONG the edge, not stacked across it', () => {
    const items = [badge({ x: 200, y: 200 }, 0), badge({ x: 200, y: 200 }, 1)];
    const result = run(items);
    expect(result.badges.every(p => p.visible)).toBe(true);
    expect(result.pills).toHaveLength(0);
    // Same distance off the edge, different positions along it.
    expect(result.badges[0].dy).toBeCloseTo(result.badges[1].dy, 9);
    expect(result.badges[0].dx).not.toBeCloseTo(result.badges[1].dx, 3);
    expect(Math.abs(result.badges[0].dy)).toBeGreaterThan(10);
  });

  it('keeps every badge visible when there is room', () => {
    const items = [0, 1, 2].map(i => badge({ x: 200, y: 200 }, i));
    const result = run(items);
    expect(result.badges.filter(p => p.visible)).toHaveLength(3);
    expect(result.pills).toHaveLength(0);
    expect(anyOverlap(boxes(items, result.badges))).toBe(false);
  });

  it('collapses into a +N pill once the row outgrows its edge', () => {
    // Ten badges on one cluster whose host edge is only 60 px on screen —
    // what a 30 mm line looks like a few zoom steps out.
    const items = Array.from({ length: 10 }, (_, i) => badge(
      { x: 200 + (i % 2) * 4, y: 200 }, i, { groupKey: `g${i % 2}`, spanPx: 60 },
    ));
    const result = run(items);
    const shown = result.badges.filter(p => p.visible).length;
    expect(shown).toBeLessThan(items.length);
    expect(result.pills).toHaveLength(1);
    // The pill accounts for exactly what was dropped — never a lie.
    expect(result.pills[0].count).toBe(items.length - shown);
  });

  it('expands as the view zooms in and collapses as it zooms out', () => {
    const make = (spanPx: number) => Array.from({ length: 5 }, (_, i) => badge(
      { x: 200, y: 200 }, i, { groupKey: 'one', spanPx },
    ));
    const shownAt = (spanPx: number) => run(make(spanPx)).badges.filter(p => p.visible).length;
    // Monotone in the on-screen size of the edge: more pixels, more badges.
    expect(shownAt(30)).toBeLessThan(shownAt(70));
    expect(shownAt(70)).toBeLessThan(shownAt(200));
    expect(shownAt(200)).toBe(5);
  });

  it('collapses the visually-obvious constraints first', () => {
    const items = [
      badge({ x: 200, y: 200 }, 0, { rank: 10, groupKey: 'a', spanPx: 60 }),
      badge({ x: 204, y: 200 }, 1, { rank: 10, groupKey: 'b', spanPx: 60 }),
      badge({ x: 208, y: 200 }, 2, { rank: 0, groupKey: 'c', spanPx: 60 }),
      badge({ x: 212, y: 200 }, 3, { rank: 10, groupKey: 'd', spanPx: 60 }),
      badge({ x: 216, y: 200 }, 4, { rank: 10, groupKey: 'e', spanPx: 60 }),
      badge({ x: 220, y: 200 }, 5, { rank: 10, groupKey: 'f', spanPx: 60 }),
    ];
    const result = run(items);
    expect(result.pills.length).toBeGreaterThan(0);
    // The rank-0 badge (a tangency, say) outlives the rank-10 crowd.
    expect(result.badges[2].visible).toBe(true);
  });

  it('never overlaps two clusters, and never starves one entirely', () => {
    // Two crowded clusters a badge-width apart.
    const items = [
      ...Array.from({ length: 4 }, (_, i) => badge({ x: 200, y: 200 }, i, { groupKey: 'left' })),
      ...Array.from({ length: 4 }, (_, i) => badge({ x: 240, y: 200 }, 4 + i, { groupKey: 'right' })),
    ];
    const result = run(items);
    const drawn = [
      ...boxes(items, result.badges),
      ...result.pills.map(p => ({ cx: p.at.x, cy: p.at.y, hw: p.hw, hh: p.hh })),
    ];
    expect(anyOverlap(drawn)).toBe(false);
    // Both clusters kept a marker of some kind.
    const leftShown = result.badges.slice(0, 4).some(p => p.visible);
    const rightShown = result.badges.slice(4).some(p => p.visible);
    expect(leftShown || result.pills.length > 0).toBe(true);
    expect(rightShown || result.pills.length > 1).toBe(true);
  });

  it('is deterministic — identical input, identical layout', () => {
    const items = Array.from({ length: 6 }, (_, i) => badge({ x: 200 + i * 6, y: 200 }, i, {
      groupKey: `g${i}`,
    }));
    expect(run(items).badges).toEqual(run(items).badges);
  });
});

describe('dimension labels', () => {
  it('parks a lone label one gap off the middle of its dimension line', () => {
    const items = [dimension({ x: 300, y: 300 }, 0)];
    const result = run([], items);
    expect(result.dimensions[0].visible).toBe(true);
    expect(result.dimensions[0].dx).toBeCloseTo(0, 9);
    expect(result.dimensions[0].dy).toBeCloseTo(DEFAULT_DECLUTTER_OPTIONS.labelOffsetPx, 9);
  });

  it('separates labels that would otherwise sit on top of each other', () => {
    const items = [
      dimension({ x: 300, y: 300 }, 0),
      dimension({ x: 300, y: 300 }, 1),
      dimension({ x: 304, y: 302 }, 2),
    ];
    const result = run([], items);
    expect(result.dimensions.every(p => p.visible)).toBe(true);
    expect(anyOverlap(boxes(items, result.dimensions))).toBe(false);
  });

  it('never hides a dimension, even with nowhere left to go', () => {
    const items = Array.from({ length: 12 }, (_, i) => dimension({ x: 300, y: 300 }, i, {
      slideRangePx: 0,
    }));
    const result = run([], items);
    expect(result.dimensions.every(p => p.visible)).toBe(true);
  });

  it('prefers clear space over sitting on the sketch geometry', () => {
    const geometry = new GeometryIndex();
    // A curve hugging the default (below-the-line) label slot.
    geometry.addSegment({ x: 200, y: 314 }, { x: 400, y: 314 });
    const items = [dimension({ x: 300, y: 300 }, 0)];
    const result = run([], items, geometry);
    expect(result.dimensions[0].dy).toBeLessThan(0);
  });

  it('gives dimension labels the space before badges take any', () => {
    const dims = [dimension({ x: 300, y: 300 }, 0)];
    const badges = [badge({ x: 300, y: 314 }, 1)];
    const result = run(badges, dims);
    const drawn = [...boxes(dims, result.dimensions), ...boxes(badges, result.badges)];
    expect(result.dimensions[0].dy).toBeCloseTo(DEFAULT_DECLUTTER_OPTIONS.labelOffsetPx, 9);
    expect(anyOverlap(drawn)).toBe(false);
  });
});
