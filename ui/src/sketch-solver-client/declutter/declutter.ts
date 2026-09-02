// The annotation declutterer (sketch-rewrite P5.5).
//
// FluidCAD is code-first: there is no "drag the dimension where you want it"
// escape hatch, so annotation layout has to be right by construction. This
// pass decides, per zoom step, where every badge and dimension label sits and
// which badges collapse behind a read-only `+N` pill.
//
// Priority order, highest first:
//   1. DIMENSION LABELS — they carry values. Never hidden: a dimension that
//      cannot find clear space is drawn at its least-bad candidate rather
//      than dropped, because a missing number misleads where an overlapping
//      one merely annoys.
//   2. BADGE CLUSTER HEADS — one guaranteed slot per cluster, reserved before
//      anybody grows, so a dense corner cannot starve its neighbour into
//      showing nothing at all.
//   3. BADGE ROW GROWTH — each cluster then takes as many slots as the space
//      around it actually allows. Whatever does not fit collapses into the
//      cluster's `+N` pill (read-only: zoom in to see them).
//
// Every decision is a pure function of the projected input, so the same
// camera always yields the same layout — no frame-to-frame jitter, no
// history dependence, and the whole thing is testable from plain numbers.

import { clusterAnchors } from './cluster';
import { GeometryIndex, NO_OWNER } from './geometry-index';
import { Occupancy } from './occupancy';
import { rowLength, rowRects } from './rows';
import { hiddenPlacement, normalize, orientReading } from './types';
import type { Placement, Pt, Rect } from './types';

/** Pixel budget knobs — all screen-space, all independent of sketch units. */
export type DeclutterOptions = {
  /** First rung: how far a badge row floats off its anchor. */
  badgeOffsetPx: number;
  /** Rung pitch when a row has to step further out to find space. */
  rungStepPx: number;
  /** Clear space between neighbours inside a row. */
  rowGapPx: number;
  /** Anchors closer than this share one row. */
  mergePx: number;
  /** First rung for a dimension label off its leader. */
  labelOffsetPx: number;
  /** Rung pitch for dimension labels. */
  labelRungPx: number;
  /** Clearance demanded between any two placed boxes. */
  padPx: number;
  /** Rungs tried before a placement gives up. */
  rungs: number;
  /** Row budget for badges with no host edge to measure (a fixed point, a
   * datum): they get a flat allowance instead. */
  defaultSpanPx: number;
  /** A badge row whose nearest edge ends up further than this from its
   * anchor grows a link stub back to it — past the first rung the pairing
   * stops being obvious (the badge counterpart of the dimension labels'
   * LABEL_LINK_THRESHOLD_PX). */
  linkThresholdPx: number;
};

export const DEFAULT_DECLUTTER_OPTIONS: DeclutterOptions = {
  badgeOffsetPx: 22,
  rungStepPx: 20,
  rowGapPx: 4,
  mergePx: 26,
  labelOffsetPx: 14,
  labelRungPx: 18,
  padPx: 2,
  rungs: 3,
  defaultSpanPx: 70,
  linkThresholdPx: 24,
};

export type BoxSize = { hw: number; hh: number };

/** One constraint badge asking for a slot near its anchor. */
export type BadgeItem = BoxSize & {
  /** Projected anchor, screen px. */
  anchor: Pt;
  /** Anchor identity: badges sharing it always share a row. */
  groupKey: string;
  /** Preferred outward normal (unit, screen px) — the side to float toward. */
  out: Pt;
  /** Row direction (unit, screen px) — the owning edge's tangent. */
  along: Pt;
  /**
   * On-screen length of the edge this badge rides — the row's space budget,
   * and the whole reason the layout responds to zoom. A row of badges longer
   * than the edge it hangs off is exactly the over-saturation this pass
   * exists to prevent: zoom out, the edge shrinks, badges collapse into the
   * pill; zoom in, the edge grows and they come back. Omitted (or 0) means
   * "no host edge" — `defaultSpanPx` applies.
   */
  spanPx?: number;
  /** Lower keeps its slot longer when a cluster overflows. */
  rank: number;
  /** Camera-independent stable order (statement order). */
  order: number;
};

export type DimensionStyle = 'span' | 'aligned';

/** One dimension label. `anchor + slide·a + push·b` spans its candidates. */
export type DimensionItem = BoxSize & {
  anchor: Pt;
  /** Unit direction the label may slide along — its own dimension line. */
  slide: Pt;
  /** Unit direction the label offsets along; the sign is the preferred side. */
  push: Pt;
  style: DimensionStyle;
  /** Half-length of the slide range in px (the leader's reach). */
  slideRangePx: number;
  /** Geometry-index owner of this label's own dimension line, so its own
   * leader does not score as clutter against it (see GeometryIndex). */
  lineOwner?: number;
  order: number;
};

/** A collapsed group's read-only counter. */
export type OverflowPill = BoxSize & {
  /** Screen position, px. */
  at: Pt;
  /** How many badges it stands for. */
  count: number;
};

export type DeclutterInput = {
  badges: BadgeItem[];
  dimensions: DimensionItem[];
  /** Boxes that are drawn but not placed by this pass (angle readouts) —
   * reserved up front so nothing lands on them. */
  obstacles: Rect[];
  geometry: GeometryIndex;
  /** Half extents of a `+N` pill, by the count it shows. */
  pillSize: (count: number) => BoxSize;
  options?: Partial<DeclutterOptions>;
};

export type DeclutterResult = {
  /** Parallel to `input.badges`. */
  badges: Placement[];
  /** Parallel to `input.dimensions` — always visible (see the header). */
  dimensions: Placement[];
  pills: OverflowPill[];
  /** Stubs from a displaced badge row's nearest edge back to its anchor —
   * the drafting answer to "whose badges are those?" once a row has been
   * pushed past `linkThresholdPx` (screen px, like everything here). */
  links: { from: Pt; to: Pt }[];
};

/** Cost of a candidate sitting on top of the sketch's own curves. Soft: it
 * loses to showing one more badge, wins against a needless extra rung. */
const CROSS_PENALTY = 5;
const RUNG_PENALTY = 4;
const FLIP_PENALTY = 2;
const SLIDE_PENALTY = 3;
/** Dominates every other term so a row keeps as many real badges as it can:
 * one collapsed badge costs more than any amount of geometry crossing. */
const HIDE_PENALTY = 1000;

function boxAt(at: Pt, size: BoxSize): Rect {
  return { cx: at.x, cy: at.y, hw: size.hw, hh: size.hh };
}

function step(from: Pt, dir: Pt, distance: number): Pt {
  return { x: from.x + dir.x * distance, y: from.y + dir.y * distance };
}

// ---------------------------------------------------------------------------
// Dimension labels
// ---------------------------------------------------------------------------

type Candidate = { at: Pt; cost: number };

/** Middle of the line first, then along it, and only then further out. */
const ALONG_LINE_STOPS = [0, 0.45, -0.45, 0.8, -0.8];

/**
 * How far along its own dimension line a label may park, as a fraction of
 * the slide range, cheapest first.
 *
 * Both styles mirror drafting practice: sit at the middle of the dimension
 * line, one gap clear of it; when that is taken, slide along the line
 * before stepping further away from it. They stay distinct because the
 * sprite layer treats them differently — an `aligned` label (a diameter's
 * chord, a radius) also ROLLS to lie along its line.
 */
const SLIDE_STOPS: Record<DimensionStyle, number[]> = {
  span: ALONG_LINE_STOPS,
  aligned: ALONG_LINE_STOPS,
};

/** Candidate positions for one dimension label, cheapest first. */
function dimensionCandidates(item: DimensionItem, opts: DeclutterOptions): Candidate[] {
  const slideStops = SLIDE_STOPS[item.style];
  const out: Candidate[] = [];
  for (let rung = 0; rung < opts.rungs; rung++) {
    for (let s = 0; s < slideStops.length; s++) {
      for (const side of [1, -1]) {
        const distance = opts.labelOffsetPx + rung * opts.labelRungPx;
        const at = step(
          step(item.anchor, item.slide, slideStops[s] * item.slideRangePx),
          item.push,
          distance * side,
        );
        out.push({
          at,
          cost: rung * RUNG_PENALTY + s * SLIDE_PENALTY + (side < 0 ? FLIP_PENALTY : 0),
        });
      }
    }
  }
  return out.sort((a, b) => a.cost - b.cost);
}

function placeDimensions(
  items: DimensionItem[],
  occ: Occupancy,
  geometry: GeometryIndex,
  opts: DeclutterOptions,
): Placement[] {
  const placements = items.map(() => hiddenPlacement());
  // Most-constrained-first: a short dimension line has the least room to
  // slide, so it picks before the long ones that can dodge around it.
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.slideRangePx - b.item.slideRangePx || a.item.order - b.item.order);

  for (const { item, index } of order) {
    const candidates = dimensionCandidates(item, opts);
    let chosen = candidates[0];
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const rect = boxAt(candidate.at, item);
      if (!occ.isFree(rect, -2, opts.padPx)) {
        continue;
      }
      const crosses = geometry.crosses(rect, item.lineOwner ?? NO_OWNER);
      const score = candidate.cost + (crosses ? CROSS_PENALTY : 0);
      if (score < bestScore) {
        bestScore = score;
        chosen = candidate;
      }
      // Candidates are cost-ordered and the only extra term is the crossing
      // penalty, so a free candidate that also clears the geometry is optimal.
      if (score === candidate.cost) {
        break;
      }
    }
    occ.add(boxAt(chosen.at, item));
    placements[index] = {
      visible: true,
      dx: chosen.at.x - item.anchor.x,
      dy: chosen.at.y - item.anchor.y,
    };
  }
  return placements;
}

// ---------------------------------------------------------------------------
// Badge clusters
// ---------------------------------------------------------------------------

type ClusterMember = { item: BadgeItem; index: number };

type BadgeCluster = {
  id: number;
  anchor: Pt;
  out: Pt;
  along: Pt;
  /** How long the row may grow along `along` (see BadgeItem.spanPx). */
  budgetPx: number;
  /** Members, best-kept first. */
  members: ClusterMember[];
};

/** Average the members' hints, folding opposite-pointing vectors together so
 * two views of the same edge don't cancel each other out. */
function averageDirection(vectors: Pt[], fallback: Pt): Pt {
  let x = 0;
  let y = 0;
  for (const v of vectors) {
    const flip = x * v.x + y * v.y < 0 ? -1 : 1;
    x += v.x * flip;
    y += v.y * flip;
  }
  return normalize({ x, y }, fallback);
}

function buildClusters(items: BadgeItem[], opts: DeclutterOptions): BadgeCluster[] {
  const byAnchor = new Map<string, { anchor: Pt; items: ClusterMember[] }>();
  items.forEach((item, index) => {
    const bucket = byAnchor.get(item.groupKey);
    if (bucket) {
      bucket.items.push({ item, index });
    } else {
      byAnchor.set(item.groupKey, { anchor: item.anchor, items: [{ item, index }] });
    }
  });

  const clusters = clusterAnchors([...byAnchor.values()], entry => entry.item.order, opts.mergePx);

  return clusters
    .map((cluster, id) => {
      const members = [...cluster.items].sort(
        (a, b) => a.item.rank - b.item.rank || a.item.order - b.item.order,
      );
      return {
        id,
        anchor: cluster.anchor,
        out: averageDirection(members.map(m => m.item.out), { x: 0, y: 1 }),
        along: orientReading(averageDirection(members.map(m => m.item.along), { x: 1, y: 0 })),
        // The most generous host edge in the cluster sets the budget — the
        // row lies along it, so that is the space genuinely available.
        budgetPx: Math.max(...members.map(m => m.item.spanPx || opts.defaultSpanPx)),
        members,
      };
    })
    // Crowded anchors claim space first — they are the ones that would
    // otherwise lose everything to a lone neighbouring badge.
    .sort((a, b) => b.members.length - a.members.length
      || a.members[0].item.order - b.members[0].item.order);
}

type RowPlan = { rects: Rect[]; cost: number };

/**
 * Cheapest side/rung a row of `boxes` fits at, or null when none does. The
 * search ignores the cluster's own reservations — pass B replaces them.
 */
function fitRow(
  cluster: BadgeCluster,
  boxes: BoxSize[],
  occ: Occupancy,
  geometry: GeometryIndex,
  opts: DeclutterOptions,
  baseCost: number,
  ceiling: number,
): RowPlan | null {
  // A single box always fits — a cluster must keep one marker however tight
  // the space. Anything longer has to earn its room off the host edge.
  if (boxes.length > 1
    && rowLength(cluster.along, boxes, opts.rowGapPx) > cluster.budgetPx) {
    return null;
  }
  let best: RowPlan | null = null;
  for (let rung = 0; rung < opts.rungs; rung++) {
    for (const side of [1, -1]) {
      let cost = baseCost + rung * RUNG_PENALTY + (side < 0 ? FLIP_PENALTY : 0);
      if (cost >= ceiling || (best && cost >= best.cost)) {
        continue;
      }
      const distance = opts.badgeOffsetPx + rung * opts.rungStepPx;
      const base = step(cluster.anchor, cluster.out, distance * side);
      const rects = rowRects(base, cluster.along, boxes, opts.rowGapPx);
      let ok = true;
      for (const rect of rects) {
        if (!occ.isFree(rect, cluster.id, opts.padPx)) {
          ok = false;
          break;
        }
        if (geometry.crosses(rect)) {
          cost += CROSS_PENALTY;
        }
      }
      if (ok && cost < ceiling && (!best || cost < best.cost)) {
        best = { rects, cost };
      }
    }
  }
  return best;
}

/** The reservation a cluster holds before anyone grows: one box, sized for
 * whatever it will end up showing there (its only badge, or the pill that
 * stands for all of them). */
function reserveHead(
  cluster: BadgeCluster,
  occ: Occupancy,
  geometry: GeometryIndex,
  pillSize: (count: number) => BoxSize,
  opts: DeclutterOptions,
): RowPlan | null {
  const total = cluster.members.length;
  const box = total === 1 ? cluster.members[0].item : pillSize(total);
  return fitRow(cluster, [box], occ, geometry, opts, 0, Infinity);
}

/** Row + overflow split for a cluster, once the neighbourhood is known. */
type GrownRow = { plan: RowPlan; visible: number; hidden: number };

function growRow(
  cluster: BadgeCluster,
  occ: Occupancy,
  geometry: GeometryIndex,
  pillSize: (count: number) => BoxSize,
  opts: DeclutterOptions,
): GrownRow | null {
  const total = cluster.members.length;
  let best: GrownRow | null = null;
  for (let visible = total; visible >= 0; visible--) {
    const hidden = total - visible;
    // Collapsing exactly one badge is never worth it — a `+1` pill is wider
    // than the badge it replaces.
    if (hidden === 1) {
      continue;
    }
    const hideCost = hidden * HIDE_PENALTY;
    if (best && hideCost >= best.plan.cost) {
      break;
    }
    const boxes: BoxSize[] = cluster.members.slice(0, visible).map(m => m.item);
    if (hidden > 0) {
      boxes.push(pillSize(hidden));
    }
    if (boxes.length === 0) {
      continue;
    }
    const plan = fitRow(
      cluster, boxes, occ, geometry, opts, hideCost, best?.plan.cost ?? Infinity,
    );
    if (plan) {
      best = { plan, visible, hidden };
    }
  }
  return best;
}

function applyRow(
  cluster: BadgeCluster,
  row: GrownRow,
  occ: Occupancy,
  placements: Placement[],
  pills: OverflowPill[],
  links: { from: Pt; to: Pt }[],
  opts: DeclutterOptions,
): void {
  occ.release(cluster.id);
  const rects = row.plan.rects;
  for (let i = 0; i < row.visible; i++) {
    const member = cluster.members[i];
    placements[member.index] = {
      visible: true,
      dx: rects[i].cx - member.item.anchor.x,
      dy: rects[i].cy - member.item.anchor.y,
    };
    occ.add(rects[i], cluster.id);
  }
  for (let i = row.visible; i < cluster.members.length; i++) {
    placements[cluster.members[i].index] = hiddenPlacement();
  }
  if (row.hidden > 0) {
    const pill = rects[rects.length - 1];
    occ.add(pill, cluster.id);
    pills.push({ at: { x: pill.cx, y: pill.cy }, hw: pill.hw, hh: pill.hh, count: row.hidden });
  }
  const link = rowLink(cluster.anchor, rects, opts.linkThresholdPx);
  if (link) {
    links.push(link);
  }
}

/**
 * Stub from a displaced row back to its anchor, or null while the row still
 * sits close enough to read as the anchor's. Measured (and drawn) to the
 * nearest point on the nearest box's boundary, so the stub stops AT the row
 * instead of running underneath the badges.
 */
function rowLink(
  anchor: Pt,
  rects: Rect[],
  thresholdPx: number,
): { from: Pt; to: Pt } | null {
  let best: { to: Pt; d2: number } | null = null;
  for (const rect of rects) {
    const x = Math.min(Math.max(anchor.x, rect.cx - rect.hw), rect.cx + rect.hw);
    const y = Math.min(Math.max(anchor.y, rect.cy - rect.hh), rect.cy + rect.hh);
    const d2 = (x - anchor.x) ** 2 + (y - anchor.y) ** 2;
    if (!best || d2 < best.d2) {
      best = { to: { x, y }, d2 };
    }
  }
  if (!best || best.d2 <= thresholdPx * thresholdPx) {
    return null;
  }
  return { from: anchor, to: best.to };
}

// ---------------------------------------------------------------------------

export function declutterAnnotations(input: DeclutterInput): DeclutterResult {
  const opts = { ...DEFAULT_DECLUTTER_OPTIONS, ...input.options };
  const occ = new Occupancy();
  for (const rect of input.obstacles) {
    occ.add(rect);
  }

  const dimensions = placeDimensions(input.dimensions, occ, input.geometry, opts);

  const badges = input.badges.map(() => hiddenPlacement());
  const pills: OverflowPill[] = [];
  const links: { from: Pt; to: Pt }[] = [];
  const clusters = buildClusters(input.badges, opts);

  // Pass A — reserve one head slot per cluster before anybody expands, so a
  // dense corner cannot starve its neighbour into showing nothing at all.
  const heads = new Map<number, RowPlan>();
  for (const cluster of clusters) {
    const head = reserveHead(cluster, occ, input.geometry, input.pillSize, opts);
    if (!head) {
      continue;
    }
    heads.set(cluster.id, head);
    occ.add(head.rects[0], cluster.id);
  }

  // Pass B — grow each reserved cluster into whatever room is really there,
  // falling back to its head slot when growth finds nothing better.
  for (const cluster of clusters) {
    const head = heads.get(cluster.id);
    if (!head) {
      continue;
    }
    const total = cluster.members.length;
    const grown = growRow(cluster, occ, input.geometry, input.pillSize, opts);
    applyRow(
      cluster,
      grown ?? { plan: head, visible: total === 1 ? 1 : 0, hidden: total === 1 ? 0 : total },
      occ,
      badges,
      pills,
      links,
      opts,
    );
  }

  return { badges, dimensions, pills, links };
}
