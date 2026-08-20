// Anchor clustering for constraint badges.
//
// Badges are screen-constant, so what crowds them is screen distance between
// their anchors — which is purely a function of zoom. Zoom out far enough and
// a tangency point, its coincidence and the neighbouring line's H badge all
// land inside 20 px of each other; they have to become ONE row (with an
// overflow pill) rather than three rows fighting for the same pixels.
//
// Leader clustering ("assign to the first cluster whose leader is in range,
// else start a new one") is used deliberately instead of single-linkage: it
// bounds a cluster's diameter at 2·radius, so a chain of evenly-spaced
// anchors along a polyline can never avalanche into one giant cluster the way
// single-linkage chaining would. The scan order is camera-independent, so the
// only thing that changes as the user zooms is which pairs are within range.

import type { Pt } from './types';

export type AnchorGroup<T> = {
  /** Projected anchor, screen px. */
  anchor: Pt;
  items: T[];
};

export type Cluster<T> = {
  /** Row anchor: the centroid of the member anchors. */
  anchor: Pt;
  items: T[];
  /** Stable, camera-independent tiebreak — the smallest member order. */
  order: number;
};

/**
 * Group anchors that land within `radiusPx` of a cluster leader. `order` must
 * be a camera-independent key (statement order): it fixes the scan order, so
 * the clustering only changes when a distance actually crosses the radius.
 */
export function clusterAnchors<T>(
  groups: AnchorGroup<T>[],
  orderOf: (item: T) => number,
  radiusPx: number,
): Cluster<T>[] {
  const scan = groups
    .map(group => ({ group, order: Math.min(...group.items.map(orderOf)) }))
    .sort((a, b) => a.order - b.order);

  const leaders: { at: Pt; sumX: number; sumY: number; count: number; items: T[]; order: number }[] = [];
  const r2 = radiusPx * radiusPx;

  for (const { group, order } of scan) {
    let target = null as (typeof leaders)[number] | null;
    let bestDist = Infinity;
    for (const leader of leaders) {
      const dx = leader.at.x - group.anchor.x;
      const dy = leader.at.y - group.anchor.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 < bestDist) {
        bestDist = d2;
        target = leader;
      }
    }
    if (target) {
      target.items.push(...group.items);
      target.sumX += group.anchor.x;
      target.sumY += group.anchor.y;
      target.count += 1;
      continue;
    }
    leaders.push({
      at: group.anchor,
      sumX: group.anchor.x,
      sumY: group.anchor.y,
      count: 1,
      items: [...group.items],
      order,
    });
  }

  return leaders.map(leader => ({
    anchor: { x: leader.sumX / leader.count, y: leader.sumY / leader.count },
    items: leader.items,
    order: leader.order,
  }));
}
